import { spawn, exec } from 'child_process';
import { WebSocketServer } from 'ws';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Scrcpy H264 Stream Server for Android Device Screen Sharing
 * Uses scrcpy for H264 video encoding and direct touch control
 * Achieves 60 FPS video with <10ms touch latency
 */

// Active streams: deviceId -> { process, clients: Set<ws>, width, height }
const activeStreams = new Map();

// WebSocket server instance
let wss = null;

/**
 * Initialize the WebSocket server for streaming
 * @param {number} port - Port to listen on (default: 8080)
 */
export function initStreamServer(port = 8080) {
  wss = new WebSocketServer({ port });
  
  console.log(`📺 Stream server started on ws://localhost:${port}`);
  
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const deviceId = url.searchParams.get('device');
    
    if (!deviceId) {
      console.error('❌ No device ID provided');
      ws.close(4000, 'Device ID required');
      return;
    }
    
    console.log(`📱 Client connected for device: ${deviceId}`);
    
    // Start streaming for this device
    await startStream(deviceId, ws);
    
    // Handle input events from browser
    ws.on('message', async (message) => {
      try {
        const event = JSON.parse(message.toString());
        await handleInputEvent(deviceId, event);
      } catch (err) {
        console.error('❌ Error handling input event:', err.message);
      }
    });
    
    // Clean up on disconnect
    ws.on('close', () => {
      console.log(`📱 Client disconnected from device: ${deviceId}`);
      removeClient(deviceId, ws);
    });
    
    ws.on('error', (err) => {
      console.error(`❌ WebSocket error for ${deviceId}:`, err.message);
      removeClient(deviceId, ws);
    });
  });
  
  return wss;
}

/**
 * Start scrcpy streaming for a device
 * @param {string} deviceId - ADB device ID
 * @param {WebSocket} ws - WebSocket client connection
 */
async function startStream(deviceId, ws) {
  // Check if stream already exists for this device
  if (activeStreams.has(deviceId)) {
    const stream = activeStreams.get(deviceId);
    stream.clients.add(ws);
    
    // Send device info to new client
    ws.send(JSON.stringify({
      type: 'info',
      deviceId,
      width: stream.width,
      height: stream.height,
      codec: 'h264'
    }));
    
    console.log(`📺 Added client to existing stream for ${deviceId}`);
    return;
  }
  
  try {
    // Check if device is available
    const { stdout: deviceList } = await execAsync('adb devices');
    if (!deviceList.includes(deviceId)) {
      throw new Error('Device not connected');
    }
    
    // Get device screen size
    const { stdout: sizeOutput } = await execAsync(
      `adb -s ${deviceId} shell wm size`
    );
    const sizeMatch = sizeOutput.match(/(\\d+)x(\\d+)/);
    const width = sizeMatch ? parseInt(sizeMatch[1]) : 1080;
    const height = sizeMatch ? parseInt(sizeMatch[2]) : 1920;
    
    // Send device info to client
    ws.send(JSON.stringify({
      type: 'info',
      deviceId,
      width,
      height,
      codec: 'h264'
    }));
    
    console.log(`📺 Starting scrcpy H264 stream for ${deviceId} (${width}x${height})`);
    
    // Start scrcpy process with H264 output
    const scrcpyProcess = spawn('scrcpy', [
      '-s', deviceId,
      '--video-codec=h264',
      '--video-encoder=c2.mtk.avc.encoder', // Hardware encoder
      '--max-size=1080',
      '--max-fps=60',
      '--video-bit-rate=4M',
      '--no-audio',
      '--no-control', // We'll handle touch separately via ADB for now
      '--no-playback', // Don't show window (scrcpy 3.3+)
      '--video-source=display'
    ]);
    
    const stream = {
      process: scrcpyProcess,
      clients: new Set([ws]),
      width,
      height,
      buffer: Buffer.alloc(0)
    };
    
    activeStreams.set(deviceId, stream);
    
    // Handle H264 video data from scrcpy stdout
    scrcpyProcess.stdout.on('data', (chunk) => {
      // Accumulate H264 data
      stream.buffer = Buffer.concat([stream.buffer, chunk]);
      
      // Send H264 chunks to all connected clients
      // Clients will decode using WebCodecs API
      stream.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(stream.buffer);
          stream.buffer = Buffer.alloc(0); // Clear buffer after sending
        }
      });
    });
    
    scrcpyProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('INFO') && !msg.includes('encoder:')) {
        console.error(`scrcpy stderr for ${deviceId}:`, msg);
      }
    });
    
    scrcpyProcess.on('error', (err) => {
      console.error(`❌ scrcpy process error for ${deviceId}:`, err.message);
      stopStream(deviceId);
    });
    
    scrcpyProcess.on('exit', (code) => {
      console.log(`📺 scrcpy exited for ${deviceId} with code ${code}`);
      stopStream(deviceId);
    });
    
  } catch (err) {
    console.error(`❌ Failed to start stream for ${deviceId}:`, err.message);
    ws.send(JSON.stringify({
      type: 'error',
      message: `Failed to connect to device: ${err.message}`
    }));
    ws.close(4001, 'Stream initialization failed');
  }
}

/**
 * Stop streaming for a device
 * @param {string} deviceId - ADB device ID
 */
export function stopStream(deviceId) {
  const stream = activeStreams.get(deviceId);
  if (!stream) return;
  
  console.log(`📺 Stopping stream for ${deviceId}`);
  
  // Kill scrcpy process
  if (stream.process) {
    stream.process.kill('SIGTERM');
  }
  
  // Close all client connections
  stream.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.close(1000, 'Stream ended');
    }
  });
  
  activeStreams.delete(deviceId);
}

/**
 * Remove a client from a device stream
 * @param {string} deviceId - ADB device ID
 * @param {WebSocket} ws - WebSocket client to remove
 */
function removeClient(deviceId, ws) {
  const stream = activeStreams.get(deviceId);
  if (!stream) return;
  
  stream.clients.delete(ws);
  
  // If no more clients, stop the stream
  if (stream.clients.size === 0) {
    console.log(`📺 No more clients for ${deviceId}, stopping stream`);
    stopStream(deviceId);
  }
}

/**
 * Handle input events from browser
 * @param {string} deviceId - ADB device ID
 * @param {Object} event - Input event object
 */
async function handleInputEvent(deviceId, event) {
  try {
    switch (event.type) {
      case 'tap':
        await execAsync(
          `adb -s ${deviceId} shell input tap ${Math.round(event.x)} ${Math.round(event.y)}`
        );
        break;
        
      case 'swipe':
        const duration = event.duration || 50;
        await execAsync(
          `adb -s ${deviceId} shell input swipe ${Math.round(event.x1)} ${Math.round(event.y1)} ${Math.round(event.x2)} ${Math.round(event.y2)} ${duration}`
        );
        break;
        
      case 'keyevent':
        await execAsync(
          `adb -s ${deviceId} shell input keyevent ${event.keycode}`
        );
        break;
        
      case 'text':
        const escapedText = event.text.replace(/'/g, "\\\\'").replace(/ /g, '%s');
        await execAsync(
          `adb -s ${deviceId} shell input text '${escapedText}'`
        );
        break;
        
      default:
        console.log(`⚠️ Unknown input event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`❌ Input event failed for ${deviceId}:`, err.message);
  }
}

/**
 * Get list of active streams
 * @returns {Array} List of device IDs with active streams
 */
export function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

/**
 * Shutdown the stream server
 */
export function shutdownStreamServer() {
  console.log('📺 Shutting down stream server...');
  
  // Stop all active streams
  activeStreams.forEach((_, deviceId) => {
    stopStream(deviceId);
  });
  
  // Close WebSocket server
  if (wss) {
    wss.close();
  }
}
