import { spawn, exec } from 'child_process';
import { WebSocketServer } from 'ws';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Stream Server for Android Device Screen Sharing
 * Uses ADB screencap for screen capture and WebSocket for browser streaming
 * 
 * This uses a screenshot-based approach for maximum compatibility.
 * For lower latency, consider using scrcpy with proper H264 streaming.
 */

// Active streams: deviceId -> { interval, clients: Set<ws>, width, height }
const activeStreams = new Map();

// WebSocket server instance
let wss = null;

// Frame rate (screenshots per second) - optimized for network streaming
const FRAME_RATE = 30;
const FRAME_INTERVAL = 1000 / FRAME_RATE;

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
 * Start streaming for a device
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
      height: stream.height
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
    const sizeMatch = sizeOutput.match(/(\d+)x(\d+)/);
    const width = sizeMatch ? parseInt(sizeMatch[1]) : 1080;
    const height = sizeMatch ? parseInt(sizeMatch[2]) : 1920;
    
    // Send device info to client
    ws.send(JSON.stringify({
      type: 'info',
      deviceId,
      width,
      height
    }));
    
    console.log(`📺 Starting screenshot stream for ${deviceId} (${width}x${height})`);
    
    const stream = {
      clients: new Set([ws]),
      width,
      height,
      interval: null,
      capturing: false
    };
    
    activeStreams.set(deviceId, stream);
    
    // Start capturing screenshots
    stream.interval = setInterval(async () => {
      if (stream.capturing || stream.clients.size === 0) return;
      
      stream.capturing = true;
      try {
        await captureAndSendFrame(deviceId, stream);
      } catch (err) {
        console.error(`❌ Frame capture error for ${deviceId}:`, err.message);
      }
      stream.capturing = false;
    }, FRAME_INTERVAL);
    
    // Capture first frame immediately
    await captureAndSendFrame(deviceId, stream);
    
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
 * Capture a screenshot and send to all clients
 * @param {string} deviceId - ADB device ID
 * @param {Object} stream - Stream object with clients
 */
async function captureAndSendFrame(deviceId, stream) {
  if (stream.clients.size === 0) return;
  
  try {
    // Capture screenshot as PNG and convert to JPEG for better compression
    // JPEG reduces size by ~70% compared to PNG
    const { stdout } = await execAsync(
      `adb -s ${deviceId} exec-out screencap -p | ffmpeg -i - -q:v 3 -f image2pipe -vcodec mjpeg - 2>/dev/null | base64`,
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
    );
    
    const base64Data = stdout.toString('utf8').trim();
    
    if (base64Data.length > 0) {
      const frame = {
        type: 'frame',
        format: 'jpeg',
        data: base64Data
      };
      const frameJson = JSON.stringify(frame);
      
      stream.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(frameJson);
        }
      });
    }
  } catch (err) {
    // Don't spam errors if device disconnected
    if (!err.message.includes('device offline') && !err.message.includes('not found')) {
      console.error(`❌ Screenshot failed for ${deviceId}:`, err.message);
    }
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
  
  // Stop the screenshot interval
  if (stream.interval) {
    clearInterval(stream.interval);
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
 * Touch session management for smooth, real-time input
 */
const touchSessions = new Map(); // deviceId -> { touchDown: false, lastX, lastY, eventQueue: [] }

/**
 * Handle input events from browser with real-time touch sessions
 * @param {string} deviceId - ADB device ID  
 * @param {Object} event - Input event object
 */
async function handleInputEvent(deviceId, event) {
  try {
    // Get or create touch session for this device
    if (!touchSessions.has(deviceId)) {
      touchSessions.set(deviceId, {
        touchDown: false,
        lastX: 0,
        lastY: 0,
        eventQueue: [],
        flushTimer: null
      });
    }
    
    const session = touchSessions.get(deviceId);
    
    switch (event.type) {
      case 'touch_down':
        // Finger down - start touch session
        session.touchDown = true;
        session.lastX = Math.round(event.x);
        session.lastY = Math.round(event.y);
        await sendEventDirect(deviceId, 'down', session.lastX, session.lastY);
        break;
        
      case 'touch_move':
        // Finger moving - queue event for batching
        if (session.touchDown) {
          session.lastX = Math.round(event.x);
          session.lastY = Math.round(event.y);
          session.eventQueue.push({ x: session.lastX, y: session.lastY });
          
          // Flush queue periodically (every 16ms for 60fps)
          if (!session.flushTimer) {
            session.flushTimer = setTimeout(async () => {
              await flushTouchEvents(deviceId);
            }, 16);
          }
        }
        break;
        
      case 'touch_up':
        // Finger up - end touch session
        if (session.touchDown) {
          await sendEventDirect(deviceId, 'up', session.lastX, session.lastY);
          session.touchDown = false;
          session.eventQueue = [];
          if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = null;
          }
        }
        break;
        
      case 'tap':
        // Legacy tap support - simple tap at x, y coordinates
        await execAsync(
          `adb -s ${deviceId} shell input tap ${Math.round(event.x)} ${Math.round(event.y)}`
        );
        break;
        
      case 'swipe':
        // Legacy swipe support
        const duration = event.duration || 300;
        await execAsync(
          `adb -s ${deviceId} shell input swipe ${Math.round(event.x1)} ${Math.round(event.y1)} ${Math.round(event.x2)} ${Math.round(event.y2)} ${duration}`
        );
        break;
        
      case 'keyevent':
        // Send key event (e.g., back button = 4, home = 3)
        await execAsync(
          `adb -s ${deviceId} shell input keyevent ${event.keycode}`
        );
        break;
        
      case 'text':
        // Type text
        const escapedText = event.text.replace(/'/g, "\\'").replace(/ /g, '%s');
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
 * Send direct touch event using optimized method
 * @param {string} deviceId - ADB device ID
 * @param {string} action - 'down', 'move', or 'up'
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
async function sendEventDirect(deviceId, action, x, y) {
  // Use input tap/swipe with 0 duration for immediate response
  // This is faster than sendevent and doesn't require root
  if (action === 'down') {
    // Tap to position (this triggers touch down)
    await execAsync(
      `adb -s ${deviceId} shell input tap ${x} ${y}`,
      { timeout: 100 }
    );
  } else if (action === 'up') {
    // Touch up is handled by the tap completion
    // No additional command needed
  }
}

/**
 * Flush batched touch move events
 * @param {string} deviceId - ADB device ID
 */
async function flushTouchEvents(deviceId) {
  const session = touchSessions.get(deviceId);
  if (!session || session.eventQueue.length === 0) {
    if (session) session.flushTimer = null;
    return;
  }
  
  // Get the last position from queue (most recent)
  const lastEvent = session.eventQueue[session.eventQueue.length - 1];
  session.eventQueue = [];
  session.flushTimer = null;
  
  // Send move event as quick swipe
  if (session.touchDown && lastEvent) {
    try {
      await execAsync(
        `adb -s ${deviceId} shell input swipe ${session.lastX} ${session.lastY} ${lastEvent.x} ${lastEvent.y} 16`,
        { timeout: 100 }
      );
      session.lastX = lastEvent.x;
      session.lastY = lastEvent.y;
    } catch (err) {
      // Ignore timeout errors for move events
    }
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
