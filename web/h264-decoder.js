/**
 * H264 Video Decoder using WebCodecs API
 * Decodes H264 frames from scrcpy and renders to canvas
 */

export class H264Decoder {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.decoder = null;
    this.init();
  }
  
  async init() {
    if (!('VideoDecoder' in window)) {
      throw new Error('WebCodecs API not supported in this browser');
    }
    
    this.decoder = new VideoDecoder({
      output: (frame) => {
        // Draw decoded frame to canvas
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
      },
      error: (err) => {
        console.error('❌ H264 decoder error:', err);
      }
    });
    
    // Configure decoder for H264
    this.decoder.configure({
      codec: 'avc1.42E01E', // H264 Baseline Profile Level 3.0
      codedWidth: 1080,
      codedHeight: 2400,
      optimizeForLatency: true
    });
    
    console.log('✅ H264 decoder initialized');
  }
  
  decode(h264Data) {
    if (!this.decoder || this.decoder.state !== 'configured') {
      console.warn('Decoder not ready');
      return;
    }
    
    try {
      const chunk = new EncodedVideoChunk({
        type: 'key', // Assume keyframe for now
        timestamp: performance.now() * 1000,
        data: h264Data
      });
      
      this.decoder.decode(chunk);
    } catch (err) {
      console.error('❌ Decode error:', err);
    }
  }
  
  updateSize(width, height) {
    this.decoder.configure({
      codec: 'avc1.42E01E',
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true
    });
  }
  
  close() {
    if (this.decoder) {
      this.decoder.close();
    }
  }
}
