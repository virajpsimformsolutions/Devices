import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { initStreamServer, shutdownStreamServer } from './stream-server.js';

const execAsync = promisify(exec);

// TODO: fill with your values from Supabase dashboard
const SUPABASE_URL = 'https://lqseziytaqypbeuopzel.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'sb_publishable_SaN7ZDNyxy0PDh3IUuZbSg_lubn9-mb'; // use env in real world
const HOST_NAME = 'android-host-1';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function updateAndroidDevices() {
  try {
    console.log('🔍 Checking for Android devices...');
    const { stdout } = await execAsync('adb devices -l');
    const lines = stdout.split('\n').slice(1);

    let deviceCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.match(/([a-zA-Z0-9.:_-]+)\s+device\b/);
      if (!match) continue;

      const deviceId = match[1];
      deviceCount++;

      const modelRes = await execAsync(
        `adb -s ${deviceId} shell getprop ro.product.model`
      );
      const model = modelRes.stdout.trim() || 'Android Device';

      const osRes = await execAsync(
        `adb -s ${deviceId} shell getprop ro.build.version.release`
      );
      const osVersion = osRes.stdout.trim() || 'unknown';

      console.log(`📱 Found device: ${deviceId} - ${model} (Android ${osVersion})`);

      const { data, error } = await supabase.from('devices').upsert(
        {
          id: deviceId,
          type: 'android',
          model,
          os_version: osVersion,
          status: 'free',
          host_name: HOST_NAME,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'id' }
      );

      if (error) {
        console.error(`❌ Failed to update device ${deviceId}:`, error);
      } else {
        console.log(`✅ Updated device ${deviceId} in database`);
      }
    }
    
    console.log(`✅ Total devices found: ${deviceCount}`);
  } catch (err) {
    console.error('❌ Error updating android devices:', err.message);
  }
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function watchInstallQueue() {
  console.log('👀 Starting to watch install_queue...');
  
  supabase
    .channel('install_queue_changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'install_queue' },
      async payload => {
        console.log('📬 New install queue entry:', payload);
        const row = payload.new;
        if (!row) return;

        const { device_id, app_path, id } = row;
        let installStatus = 'pending';
        let errorMessage = null;

        try {
          // Get download URL from Supabase storage
          const { data: { publicUrl } } = supabase.storage.from('apps').getPublicUrl(app_path);

          console.log(`📥 Downloading ${app_path} for ${device_id}...`);
          console.log(`🔗 URL: ${publicUrl}`);
          
          // Create temp directory if it doesn't exist
          const tempDir = path.join(process.cwd(), 'temp');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
            console.log(`📁 Created temp directory: ${tempDir}`);
          }
          
          // Download APK to temp file
          const tempApk = path.join(tempDir, `${device_id}_${Date.now()}.apk`);
          await downloadFile(publicUrl, tempApk);
          console.log(`✅ Downloaded to: ${tempApk}`);
          
          console.log(`📦 Installing on ${device_id}...`);
          const result = await execAsync(`adb -s ${device_id} install -r "${tempApk}"`);
          console.log(`✅ Install success: ${result.stdout}`);
          installStatus = 'success';

          // Clean up temp file
          fs.unlinkSync(tempApk);
          console.log(`🗑️  Cleaned up temp file`);
        } catch (err) {
          installStatus = 'failed';
          errorMessage = err.message;
          console.error(`❌ Install error for ${device_id}:`, err.message);
          console.error('Stack trace:', err.stack);
        } finally {
          // Always delete queue entry (success or failure)
          try {
            const deleteResult = await supabase
              .from('install_queue')
              .delete()
              .eq('id', id);

            console.log(`🗑️  Deleted queue entry ${id} (Status: ${installStatus})`);
            
            if (installStatus === 'success') {
              console.log(`✅ Installation complete for ${device_id}`);
            } else {
              console.log(`⚠️  Installation failed for ${device_id}: ${errorMessage}`);
            }
          } catch (delErr) {
            console.error(`❌ Failed to delete queue entry ${id}:`, delErr.message);
          }
        }
      }
    )
    .subscribe(status => {
      console.log('📡 Install queue subscription status:', status);
    });
}

async function main() {
  console.log('🚀 Starting device host...');
  console.log('📍 Host name:', HOST_NAME);
  console.log('🔗 Supabase URL:', SUPABASE_URL);
  console.log('⏰ Device scan interval: 30 seconds');
  console.log('');
  
  await updateAndroidDevices();
  setInterval(updateAndroidDevices, 30_000);
  await watchInstallQueue();
  
  // Start the streaming server
  const STREAM_PORT = process.env.STREAM_PORT || 8080;
  initStreamServer(STREAM_PORT);
  
  console.log('');
  console.log('✅ Device host is running!');
  console.log(`📺 Stream server: ws://localhost:${STREAM_PORT}`);
  console.log('');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\\n🛑 Shutting down...');
  shutdownStreamServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\\n🛑 Shutting down...');
  shutdownStreamServer();
  process.exit(0);
});

main().catch(err => console.error(err));

