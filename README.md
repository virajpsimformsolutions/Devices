# Supabase Device Farm (Mini BrowserStack)

This repo is a starting point for a self-hosted device farm using:

- Supabase (Auth, Postgres, Storage, Realtime)
- ADB + Android devices
- Static web frontend

## Setup

1. Create a Supabase project.
2. Run the SQL in `README` to create `devices` and `install_queue` tables and policies.
3. Create a Storage bucket named `apps`.
4. Put your Supabase URL & keys into:
   - `backend/device-host.js`
   - `web/index.html`
5. On a machine with Android devices connected:
   ```bash
   cd backend
   npm install
   npm start
