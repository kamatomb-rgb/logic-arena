/* ==========================================================================
   LOGIC ARENA — config.js
   Only PUBLIC, safe-for-the-browser values go here: the Supabase project
   URL and the "anon" (publishable) key. Both are meant to be visible on the
   client — access to your data is controlled by the Row Level Security
   policies in supabase/schema.sql, not by hiding this key.

   NEVER put your Supabase "service_role" key or your Gemini API key here.
   Those stay server-side only, as environment variables on Netlify
   (see README.md → "Deploy").
   ========================================================================== */

window.LOGIC_ARENA_CONFIG = {
  SUPABASE_URL: 'https://ojasowriakzgazejich.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qYXNvd3JpYWt6amdhemVqaWNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MjI4MDYsImV4cCI6MjA5OTI5ODgwNn0.8SnvX7IYqA1ek4ET04WukUlBMHc2Ncp4oRZHNCjyF3o',
};
