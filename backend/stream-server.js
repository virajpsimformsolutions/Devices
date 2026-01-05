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

// Frame rate (screenshots per second) - 60 FPS for smooth animations
const FRAME_RATE = 60;
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
        await handleInputEvent(deviceId, event, ws);
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
 * @param {WebSocket} ws - WebSocket connection for responses
 */
async function handleInputEvent(deviceId, event, ws) {
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
        
      case 'start_recording':
        // Start screen recording
        await startScreenRecording(deviceId);
        break;
        
      case 'stop_recording':
        // Stop and download recording
        const recordingPath = await stopScreenRecording(deviceId);
        // Send recording path back to client
        break;
        
      case 'get_clipboard':
        // Get device clipboard
        const clipboardText = await getDeviceClipboard(deviceId);
        // Send clipboard content back
        break;
        
      case 'set_clipboard':
        // Set device clipboard
        await setDeviceClipboard(deviceId, event.text);
        break;
        
      case 'start_logcat':
        // Start logcat streaming
        startLogcatStream(deviceId, ws);
        break;
        
      case 'stop_logcat':
        // Stop logcat streaming
        stopLogcatStream(deviceId);
        break;
        
      case 'upload_file':
        // Upload file to device
        await uploadFileToDevice(deviceId, event.filename, event.data);
        ws.send(JSON.stringify({
          type: 'file_uploaded',
          filename: event.filename
        }));
        break;
        
      case 'set_location':
        // Set mock GPS location
        await setMockLocation(deviceId, event.latitude, event.longitude, event.altitude || 0);
        ws.send(JSON.stringify({
          type: 'location_set',
          latitude: event.latitude,
          longitude: event.longitude
        }));
        break;
        
      case 'get_device_info':
        // Get enhanced device stats
        const deviceInfo = await getEnhancedDeviceInfo(deviceId);
        ws.send(JSON.stringify({
          type: 'device_info',
          data: deviceInfo
        }));
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

/**
 * ===== PHASE 1: BROWSERSTACK FEATURES =====
 */

// Screen recording management
const activeRecordings = new Map(); // deviceId -> { process, startedAt }

/**
 * Start screen recording on device
 * @param {string} deviceId - ADB device ID
 */
async function startScreenRecording(deviceId) {
  if (activeRecordings.has(deviceId)) {
    console.log(`⚠️ Recording already active for ${deviceId}`);
    return;
  }
  
  try {
    // Start screenrecord on device (Android supports up to 3 minutes)
    const recordProcess = spawn('adb', [
      '-s', deviceId,
      'shell', 'screenrecord',
      '--bit-rate', '6000000', // 6 Mbps for high quality
      '/sdcard/screen_recording.mp4'
    ]);
    
    activeRecordings.set(deviceId, {
      process: recordProcess,
      startedAt: Date.now()
    });
    
    console.log(`🎬 Started recording for ${deviceId}`);
    
    // Auto-stop after 3 minutes (Android limit)
    setTimeout(() => {
      if (activeRecordings.has(deviceId)) {
        stopScreenRecording(deviceId);
      }
    }, 3 * 60 * 1000);
    
  } catch (err) {
    console.error(`❌ Failed to start recording for ${deviceId}:`, err.message);
  }
}

/**
 * Stop screen recording and pull file from device
 * @param {string} deviceId - ADB device ID
 * @returns {string} Local path to recording file
 */
async function stopScreenRecording(deviceId) {
  const recording = activeRecordings.get(deviceId);
  if (!recording) {
    console.log(`⚠️ No active recording for ${deviceId}`);
    return null;
  }
  
  try {
    // Stop recording process (Ctrl+C)
    recording.process.kill('SIGINT');
    
    // Wait a bit for file to be written
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create recordings directory if it doesn't exist
    const recordingsDir = path.join(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
    
    // Pull recording from device
    const timestamp = Date.now();
    const localPath = path.join(recordingsDir, `recording_${deviceId}_${timestamp}.mp4`);
    
    await execAsync(`adb -s ${deviceId} pull /sdcard/screen_recording.mp4 "${localPath}"`);
    
    // Clean up device file
    await execAsync(`adb -s ${deviceId} shell rm /sdcard/screen_recording.mp4`);
    
    activeRecordings.delete(deviceId);
    
    console.log(`✅ Recording saved to ${localPath}`);
    return localPath;
    
  } catch (err) {
    console.error(`❌ Failed to stop recording for ${deviceId}:`, err.message);
    activeRecordings.delete(deviceId);
    return null;
  }
}

/**
 * Get device clipboard content
 * @param {string} deviceId - ADB device ID
 * @returns {string} Clipboard text
 */
async function getDeviceClipboard(deviceId) {
  try {
    const { stdout } = await execAsync(
      `adb -s ${deviceId} shell "am broadcast -a clipper.get 2>/dev/null || dumpsys clipboard | grep -A 1 text="`
    );
    return stdout.trim();
  } catch (err) {
    console.error(`❌ Failed to get clipboard from ${deviceId}:`, err.message);
    return '';
  }
}

/**
 * Set device clipboard content
 * @param {string} deviceId - ADB device ID
 * @param {string} text - Text to set
 */
async function setDeviceClipboard(deviceId, text) {
  try {
    // Escape special characters
    const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
    
    await execAsync(
      `adb -s ${deviceId} shell "am broadcast -a clipper.set -e text '${escapedText}' 2>/dev/null || input text '${escapedText}'"`
    );
    
    console.log(`📋 Clipboard set for ${deviceId}`);
  } catch (err) {
    console.error(`❌ Failed to set clipboard for ${deviceId}:`, err.message);
  }
}

/**
 * Get device info (battery, memory, etc.)
 * @param {string} deviceId - ADB device ID
 * @returns {Object} Device information
 */
async function getDeviceInfo(deviceId) {
  try {
    // Get battery info
    const { stdout: batteryOutput } = await execAsync(
      `adb -s ${deviceId} shell dumpsys battery | grep level`
    );
    const batteryMatch = batteryOutput.match(/level: (\d+)/);
    const batteryLevel = batteryMatch ? parseInt(batteryMatch[1]) : null;
    
    // Get memory info
    const { stdout: memOutput } = await execAsync(
      `adb -s ${deviceId} shell dumpsys meminfo | grep 'Total RAM'`
    );
    const memMatch = memOutput.match(/([\d,]+)K/);
    const totalMemory = memMatch ? parseInt(memMatch[1].replace(/,/g, '')) / 1024 : null; // Convert to MB
    
    return {
      battery: batteryLevel,
      memoryMB: Math.round(totalMemory || 0)
    };
  } catch (err) {
    console.error(`❌ Failed to get device info for ${deviceId}:`, err.message);
    return { battery: null, memoryMB: null };
  }
}

/**
 * ===== PHASE 2: DEVELOPER TOOLS =====
 */

// Logcat stream management
const activeLogcats = new Map(); // deviceId -> { process, ws }

/**
 * Start logcat streaming to client
 * @param {string} deviceId - ADB device ID
 * @param {WebSocket} ws - WebSocket client
 */
function startLogcatStream(deviceId, ws) {
  // Stop existing logcat if any
  stopLogcatStream(deviceId);
  
  try {
    // Start logcat with timestamps and filtering
    const logcatProcess = spawn('adb', [
      '-s', deviceId,
      'logcat',
      '-v', 'time', // Include timestamps
      '*:V' // Verbose level for all tags
    ]);
    
    activeLogcats.set(deviceId, {
      process: logcatProcess,
      ws: ws
    });
    
    // Send log lines to client
    logcatProcess.stdout.on('data', (data) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        const logLines = data.toString().split('\n');
        logLines.forEach(line => {
          if (line.trim()) {
            ws.send(JSON.stringify({
              type: 'log',
              data: line
            }));
          }
        });
      }
    });
    
    logcatProcess.stderr.on('data', (data) => {
      console.error(`Logcat error for ${deviceId}:`, data.toString());
    });
    
    logcatProcess.on('exit', (code) => {
      console.log(`📱 Logcat exited for ${deviceId} with code ${code}`);
      activeLogcats.delete(deviceId);
    });
    
    console.log(`📱 Started logcat stream for ${deviceId}`);
    
  } catch (err) {
    console.error(`❌ Failed to start logcat for ${deviceId}:`, err.message);
  }
}

/**
 * Stop logcat streaming
 * @param {string} deviceId - ADB device ID
 */
function stopLogcatStream(deviceId) {
  const logcat = activeLogcats.get(deviceId);
  if (logcat) {
    logcat.process.kill('SIGTERM');
    activeLogcats.delete(deviceId);
    console.log(`📱 Stopped logcat stream for ${deviceId}`);
  }
}

/**
 * Upload file to device storage
 * @param {string} deviceId - ADB device ID
 * @param {string} filename - File name
 * @param {string} base64Data - Base64 encoded file data
 */
async function uploadFileToDevice(deviceId, filename, base64Data) {
  try {
    // Create temp file
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempPath = path.join(tempDir, filename);
    
    // Decode base64 and write to temp file
    const fileBuffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(tempPath, fileBuffer);
    
    // Push to device Downloads folder
    await execAsync(
      `adb -s ${deviceId} push "${tempPath}" /sdcard/Download/${filename}`
    );
    
    // Clean up temp file
    fs.unlinkSync(tempPath);
    
    console.log(`📁 Uploaded ${filename} to ${deviceId}`);
    
  } catch (err) {
    console.error(`❌ Failed to upload file to ${deviceId}:`, err.message);
    throw err;
  }
}

/**
 * ===== PHASE 3: ADVANCED FEATURES =====
 */

/**
 * Set mock GPS location on device
 * @param {string} deviceId - ADB device ID
 * @param {number} latitude - Latitude coordinate
 * @param {number} longitude - Longitude coordinate
 * @param {number} altitude - Altitude in meters
 */
async function setMockLocation(deviceId, latitude, longitude, altitude = 0) {
  try {
    // Enable mock locations globally
    await execAsync(
      `adb -s ${deviceId} shell settings put secure mock_location 1`
    );
    
    // Grant mock location permission to shell
    await execAsync(
      `adb -s ${deviceId} shell appops set com.android.shell android:mock_location allow`
    );
    
    // Modern way (Android 11+): Use cmd location
    try {
      // First, add a test provider if it doesn't exist
      await execAsync(`adb -s ${deviceId} shell cmd location providers add-test-provider gps`);
      // Enable it
      await execAsync(`adb -s ${deviceId} shell cmd location providers set-test-provider-enabled gps true`);
      // Set the location
      await execAsync(`adb -s ${deviceId} shell cmd location providers set-test-provider-location gps --location ${latitude},${longitude}`);
      console.log(`📍 Modern mock location set to ${latitude}, ${longitude}`);
      return;
    } catch (modernErr) {
      console.log(`⚠️ Modern location command failed, falling back to legacy methods: ${modernErr.message}`);
    }

    // Legacy way: broadcast intent or setprop
    await execAsync(
      `adb -s ${deviceId} shell am start -a android.location.GPS_ENABLED_CHANGE`
    );
    
    await execAsync(`adb -s ${deviceId} shell "setprop persist.sys.mock.location.latitude ${latitude}"`);
    await execAsync(`adb -s ${deviceId} shell "setprop persist.sys.mock.location.longitude ${longitude}"`);
    
    console.log(`📍 Legacy mock location set to ${latitude}, ${longitude}`);
    
  } catch (err) {
    console.error(`❌ Failed to set mock location for ${deviceId}:`, err.message);
  }
}

/**
 * Get enhanced device performance metrics
 * @param {string} deviceId - ADB device ID
 * @returns {Object} Enhanced device information
 */
async function getEnhancedDeviceInfo(deviceId) {
  try {
    const metrics = {};
    
    // Battery info
    try {
      const { stdout: batteryOutput } = await execAsync(
        `adb -s ${deviceId} shell dumpsys battery`
      );
      const levelMatch = batteryOutput.match(/level: (\d+)/);
      const tempMatch = batteryOutput.match(/temperature: (\d+)/);
      const healthMatch = batteryOutput.match(/health: (\d+)/);
      
      metrics.battery = {
        level: levelMatch ? parseInt(levelMatch[1]) : null,
        temperature: tempMatch ? Math.round(parseInt(tempMatch[1]) / 10) : null, // °C
        health: healthMatch ? parseInt(healthMatch[1]) : null
      };
    } catch (err) {
      metrics.battery = { level: null, temperature: null, health: null };
    }
    
    // Memory info
    try {
      const { stdout: memOutput } = await execAsync(
        `adb -s ${deviceId} shell dumpsys meminfo | grep "Total RAM"`
      );
      const memMatch = memOutput.match(/([\d,]+)K/);
      const totalMemKB = memMatch ? parseInt(memMatch[1].replace(/,/g, '')) : 0;
      
      const { stdout: freeMemOutput } = await execAsync(
        `adb -s ${deviceId} shell cat /proc/meminfo | grep MemAvailable`
      );
      const freeMemMatch = freeMemOutput.match(/([\d,]+)/);
      const freeMemKB = freeMemMatch ? parseInt(freeMemMatch[1]) : 0;
      
      metrics.memory = {
        used: Math.round((totalMemKB - freeMemKB) / 1024), // MB
        total: Math.round(totalMemKB / 1024), // MB
        percent: Math.round(((totalMemKB - freeMemKB) / totalMemKB) * 100)
      };
    } catch (err) {
      metrics.memory = { used: null, total: null, percent: null };
    }
    
    // CPU info (simplified - just get load average)
    try {
      const { stdout: cpuOutput } = await execAsync(
        `adb -s ${deviceId} shell cat /proc/loadavg`
      );
      const loadMatch = cpuOutput.match(/([\d.]+)/);
      const load = loadMatch ? parseFloat(loadMatch[1]) : 0;
      
      // Convert load to approximate percentage (assuming 4 cores)
      metrics.cpu = {
        usage: Math.min(Math.round(load * 25), 100) // Rough estimate
      };
    } catch (err) {
      metrics.cpu = { usage: null };
    }
    
    // Network stats
    try {
      // Try common interfaces: wlan0, eth0, rmnet_data0, ccmni
      const { stdout: networkOutput } = await execAsync(
        `adb -s ${deviceId} shell cat /proc/net/dev | grep -E "wlan0|eth0|rmnet|ccmni" | head -n 1`
      );
      
      const line = networkOutput.trim();
      if (line) {
        // Skip interface name (e.g., "wlan0:") and parse values
        const stats = line.split(":")[1].trim().split(/\s+/);
        metrics.network = {
          downloadMB: parseFloat((parseInt(stats[0]) / 1024 / 1024).toFixed(2)),
          uploadMB: parseFloat((parseInt(stats[8]) / 1024 / 1024).toFixed(2))
        };
      } else {
        metrics.network = { downloadMB: 0, uploadMB: 0 };
      }
    } catch (err) {
      metrics.network = { downloadMB: 0, uploadMB: 0 };
    }
    
    return metrics;
    
  } catch (err) {
    console.error(`❌ Failed to get enhanced device info for ${deviceId}:`, err.message);
    return {
      battery: { level: null, temperature: null },
      memory: { used: null, total: null },
      cpu: { usage: null },
      network: { downloadMB: 0, uploadMB: 0 }
    };
  }
}
