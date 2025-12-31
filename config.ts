import Constants from 'expo-constants';

const ENV = {
  ANILIST_CLIENT_ID: Constants.expoConfig?.extra?.ANILIST_CLIENT_ID as string,
  ANILIST_CLIENT_SECRET: Constants.expoConfig?.extra?.ANILIST_CLIENT_SECRET as string,
  ANILIST_REDIRECT_URI: Constants.expoConfig?.extra?.ANILIST_REDIRECT_URI as string,
  DEV_ANILIST_CLIENT_ID: Constants.expoConfig?.extra?.DEV_ANILIST_CLIENT_ID as string,
  DEV_ANILIST_CLIENT_SECRET: Constants.expoConfig?.extra?.DEV_ANILIST_CLIENT_SECRET as string,
  DEV_ANILIST_REDIRECT_URI: Constants.expoConfig?.extra?.DEV_ANILIST_REDIRECT_URI as string,
  SUPABASE_URL: Constants.expoConfig?.extra?.SUPABASE_URL as string,
  SUPABASE_ANON_KEY: Constants.expoConfig?.extra?.SUPABASE_ANON_KEY as string,
  // Zencloud API
  ZEN_API_KEY: Constants.expoConfig?.extra?.ZEN_API_KEY as string,
  // Discord Supabase (for Discord OAuth)
  DISCORD_SUPABASE_URL: Constants.expoConfig?.extra?.DISCORD_SUPABASE_URL as string,
  DISCORD_SUPABASE_ANON_KEY: Constants.expoConfig?.extra?.DISCORD_SUPABASE_ANON_KEY as string,
};

export default ENV; 