import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

// Official Supabase client specifically for Discord OAuth
function getDiscordSupabaseConfig() {
  let supabaseUrl = '';
  let supabaseAnonKey = '';

  try {
    // Try Expo Constants first (for React Native/Expo Go)
    const env = Constants.expoConfig?.extra || {};
    supabaseUrl = env.DISCORD_SUPABASE_URL || '';
    supabaseAnonKey = env.DISCORD_SUPABASE_ANON_KEY || '';
  } catch (error) {
    console.warn('[DiscordAuth] Failed to load config from Expo Constants:', error);
  }

  // Fallback to process.env for Node.js environments
  if ((!supabaseUrl || !supabaseAnonKey) && typeof process !== 'undefined' && process.env) {
    supabaseUrl = supabaseUrl || process.env.DISCORD_SUPABASE_URL || '';
    supabaseAnonKey = supabaseAnonKey || process.env.DISCORD_SUPABASE_ANON_KEY || '';
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('[DiscordAuth] ⚠️ Discord Supabase credentials not found in environment variables');
  }

  return { supabaseUrl, supabaseAnonKey };
}

const { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } = getDiscordSupabaseConfig();

export const discordSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

console.log('🔷 Discord Supabase client initialized:', SUPABASE_URL); 