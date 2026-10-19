'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tibgfhxiggnkjxfkninl.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabaseClient = null;

function getSupabase() {
  if (!supabaseClient && SUPABASE_URL && SUPABASE_KEY) {
    try {
      supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false }
      });
    } catch (err) {
      console.warn('[supabase] Initialization warning:', err.message);
    }
  }
  return supabaseClient;
}

async function checkSupabaseHealth() {
  if (!SUPABASE_KEY) {
    return {
      connected: false,
      url: SUPABASE_URL,
      status: 'pending_key',
      message: 'Supabase URL configured, awaiting SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env'
    };
  }

  try {
    const client = getSupabase();
    if (!client) {
      return { connected: false, url: SUPABASE_URL, status: 'error', message: 'Client could not be initialized' };
    }
    const { data, error } = await client.from('tables').select('id').limit(1);
    if (error) {
      return {
        connected: false,
        url: SUPABASE_URL,
        status: 'error',
        message: error.message
      };
    }
    return {
      connected: true,
      url: SUPABASE_URL,
      status: 'connected',
      message: 'Successfully connected to remote Supabase database'
    };
  } catch (err) {
    return {
      connected: false,
      url: SUPABASE_URL,
      status: 'unreachable',
      message: err.message
    };
  }
}

module.exports = {
  getSupabase,
  checkSupabaseHealth,
  SUPABASE_URL
};
