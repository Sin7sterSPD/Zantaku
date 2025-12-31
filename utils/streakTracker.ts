import * as SecureStore from 'expo-secure-store';
import { STORAGE_KEY } from '../constants/auth';
import { format, differenceInCalendarDays, isSameDay, differenceInHours, isYesterday } from 'date-fns';

// Cache constants
const STREAK_CACHE_KEY = 'streak_last_check';
const STREAK_DATA_KEY_PREFIX = 'streak_data_'; // Prefix for per-user streak data
const CACHE_EXPIRY_HOURS = 4; // Recheck every 4 hours

// Types for AniList API responses
interface MediaEntry {
  updatedAt: number; // Unix timestamp
  media: {
    id: number;
    episodes?: number;
    chapters?: number;
    type: 'ANIME' | 'MANGA';
  };
}

interface MediaListCollection {
  lists: {
    entries: MediaEntry[];
  }[];
}

interface StreakData {
  anilist_id: number;
  last_active: string;
  current_streak: number;
  longest_streak: number;
  type: 'anime' | 'manga' | 'combo' | 'none';
}

// Define the activity interface
interface Activity {
  id: number;
  status: string;
  progress: number;
  createdAt: number;
  media?: {
    id: number;
    type: 'ANIME' | 'MANGA';
    title: {
      userPreferred: string;
    };
    coverImage: {
      medium: string;
    };
  };
}

// Helper function to determine the type of activity (anime, manga, or combo)
function determineActivityType(recentActivities: Activity[]): 'anime' | 'manga' | 'combo' | 'none' {
  if (!recentActivities || recentActivities.length === 0) {
    return 'none';
  }
  
  // Count anime and manga activities in the last week
  const animeActivities = recentActivities.filter(activity => 
    activity.media?.type === 'ANIME'
  ).length;
  
  const mangaActivities = recentActivities.filter(activity => 
    activity.media?.type === 'MANGA'
  ).length;
  
  // Determine dominant type
  if (animeActivities > 0 && mangaActivities === 0) {
    return 'anime';
  } else if (mangaActivities > 0 && animeActivities === 0) {
    return 'manga';
  } else if (animeActivities > 0 && mangaActivities > 0) {
    return 'combo';
  } else {
    return 'none';
  }
}

// Main function to check and update user streaks
export async function checkAndUpdateStreaks(anilistId: number): Promise<StreakData | null> {
  try {
    console.log('Checking streak update for user:', anilistId);
    
    // Check if we've already updated the streak today
    const shouldSkipUpdate = await shouldSkipStreakUpdate();
    if (shouldSkipUpdate) {
      console.log('Skipping streak update, already checked recently');
      
      // Return existing streak data without making API calls
      return await getUserStreakData(anilistId);
    }
    
    console.log('Performing full streak update');
    
    // First, check if user already has streak data
    const existingStreak = await getUserStreakData(anilistId);
    
    // Fetch today's activity from AniList
    const token = await SecureStore.getItemAsync(STORAGE_KEY.AUTH_TOKEN);
    if (!token) {
      console.error('No auth token found');
      return null;
    }
    
    // Get anime activity
    const animeActivity = await fetchRecentActivity(anilistId, 'ANIME', token);
    
    // Get manga activity
    const mangaActivity = await fetchRecentActivity(anilistId, 'MANGA', token);
    
    // Process the activities
    const { hasAnimeActivity, hasMangaActivity, latestActivityDate } = 
      processActivities(animeActivity, mangaActivity);
    
    if (!latestActivityDate) {
      console.log('No recent activities found');
      // Update cache timestamp
      await updateStreakCheckTimestamp();
      return existingStreak || createNewStreakData(anilistId);
    }
    
    // Determine activity type
    let activityType: 'anime' | 'manga' | 'combo' | 'none' = 'none';
    if (hasAnimeActivity && hasMangaActivity) {
      activityType = 'combo';
    } else if (hasAnimeActivity) {
      activityType = 'anime';
    } else if (hasMangaActivity) {
      activityType = 'manga';
    }
    
    // Update streak data
    const updatedStreak = updateStreakData(
      existingStreak || createNewStreakData(anilistId),
      latestActivityDate,
      activityType
    );
    
    // Save updated streak to local storage
    await saveStreakData(updatedStreak);
    
    // Update cache timestamp
    await updateStreakCheckTimestamp();
    
    return updatedStreak;
  } catch (error) {
    console.error('Error checking and updating streaks:', error);
    return null;
  }
}

// Check if we should skip streak update to avoid unnecessary API calls
async function shouldSkipStreakUpdate(): Promise<boolean> {
  try {
    const lastCheckStr = await SecureStore.getItemAsync(STREAK_CACHE_KEY);
    if (!lastCheckStr) return false;
    
    const lastCheck = new Date(lastCheckStr);
    const now = new Date();
    
    // Check if we already performed a check today within the expiry window
    if (isSameDay(lastCheck, now)) {
      const hoursSinceLastCheck = differenceInHours(now, lastCheck);
      return hoursSinceLastCheck < CACHE_EXPIRY_HOURS;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking streak cache:', error);
    return false;
  }
}

// Update the timestamp of the last streak check
async function updateStreakCheckTimestamp(): Promise<void> {
  try {
    const now = new Date().toISOString();
    await SecureStore.setItemAsync(STREAK_CACHE_KEY, now);
  } catch (error) {
    console.error('Error updating streak check timestamp:', error);
  }
}

// Fetch recent activity from AniList
async function fetchRecentActivity(
  userId: number, 
  type: 'ANIME' | 'MANGA', 
  token: string
): Promise<MediaEntry[]> {
  try {
    const query = `
      query ($userId: Int, $type: MediaType) {
        MediaListCollection(userId: $userId, type: $type, status: CURRENT) {
          lists {
            entries {
              updatedAt
              media {
                id
                episodes
                chapters
                type
              }
            }
          }
        }
      }
    `;
    
    const variables = {
      userId,
      type
    };
    
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        query,
        variables
      })
    });
    
    if (!response.ok) {
      throw new Error(`AniList API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return [];
    }
    
    // Extract entries from the collection
    const collection = data.data?.MediaListCollection as MediaListCollection | undefined;
    if (!collection) return [];
    
    return collection.lists.flatMap(list => list.entries);
  } catch (error) {
    console.error(`Error fetching ${type} activity:`, error);
    return [];
  }
}

// Process activities to determine most recent activity
function processActivities(
  animeEntries: MediaEntry[], 
  mangaEntries: MediaEntry[]
): {
  hasAnimeActivity: boolean;
  hasMangaActivity: boolean;
  latestActivityDate: Date | null;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Filter activities for today
  const todayAnimeActivities = animeEntries.filter(entry => {
    const date = new Date(entry.updatedAt * 1000);
    return isSameDay(date, today);
  });
  
  const todayMangaActivities = mangaEntries.filter(entry => {
    const date = new Date(entry.updatedAt * 1000);
    return isSameDay(date, today);
  });
  
  const hasAnimeActivity = todayAnimeActivities.length > 0;
  const hasMangaActivity = todayMangaActivities.length > 0;
  
  // Get the latest activity date
  let latestActivityDate: Date | null = null;
  
  if (hasAnimeActivity || hasMangaActivity) {
    // If we have activity today, use today's date
    latestActivityDate = today;
  } else {
    // Otherwise find the most recent activity
    const allEntries = [...animeEntries, ...mangaEntries];
    if (allEntries.length > 0) {
      // Sort by updatedAt (descending)
      allEntries.sort((a, b) => b.updatedAt - a.updatedAt);
      latestActivityDate = new Date(allEntries[0].updatedAt * 1000);
    }
  }
  
  return {
    hasAnimeActivity,
    hasMangaActivity,
    latestActivityDate
  };
}

// Update streak data based on activity
function updateStreakData(
  existingData: StreakData,
  latestActivityDate: Date,
  activityType: 'anime' | 'manga' | 'combo' | 'none'
): StreakData {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const lastActive = existingData.last_active 
    ? new Date(existingData.last_active) 
    : new Date(0); // Default to epoch start if no last activity
  
  const updatedData = { ...existingData };
  
  // If activity type is none, don't update the streak
  if (activityType === 'none') {
    return updatedData;
  }
  
  // Check if we already counted today
  if (isSameDay(lastActive, today)) {
    // If the activity type has improved (e.g., from anime to combo), update it
    if ((existingData.type === 'anime' || existingData.type === 'manga') && activityType === 'combo') {
      updatedData.type = 'combo';
    }
  } 
  // If it's a new day with activity
  else if (isSameDay(latestActivityDate, today)) {
    // Check if yesterday was the last active day
    const dayDifference = differenceInCalendarDays(today, lastActive);
    
    if (dayDifference === 1) {
      // Continue the streak
      updatedData.current_streak += 1;
    } else {
      // Streak was broken, start a new one
      updatedData.longest_streak = Math.max(
        updatedData.longest_streak, 
        updatedData.current_streak
      );
      updatedData.current_streak = 1;
    }
    
    // Update the last active date and type
    updatedData.last_active = today.toISOString();
    updatedData.type = activityType;
  }
  
  // Always update the longest streak if current is higher
  if (updatedData.current_streak > updatedData.longest_streak) {
    updatedData.longest_streak = updatedData.current_streak;
  }
  
  return updatedData;
}

// Get user streak data from local storage
async function getUserStreakData(anilistId: number): Promise<StreakData | null> {
  try {
    const storageKey = `${STREAK_DATA_KEY_PREFIX}${anilistId}`;
    const streakDataJson = await SecureStore.getItemAsync(storageKey);
    
    if (!streakDataJson) {
      console.log('No streak data found for user in local storage');
      return null;
    }
    
    const streakData = JSON.parse(streakDataJson) as StreakData;
    console.log('Successfully loaded streak data from local storage:', {
      anilist_id: streakData.anilist_id,
      current_streak: streakData.current_streak,
      longest_streak: streakData.longest_streak
    });
    
    return streakData;
  } catch (error) {
    console.error('Error getting user streak data from local storage:', error);
    return null;
  }
}

// Save streak data to local storage
async function saveStreakData(data: StreakData): Promise<void> {
  try {
    const storageKey = `${STREAK_DATA_KEY_PREFIX}${data.anilist_id}`;
    await SecureStore.setItemAsync(storageKey, JSON.stringify(data));
    console.log('Successfully saved streak data to local storage');
  } catch (error) {
    console.error('Error saving streak data to local storage:', error);
  }
}

// Create a new streak data object
function createNewStreakData(anilistId: number): StreakData {
  return {
    anilist_id: anilistId,
    last_active: new Date(0).toISOString(), // Default to epoch start
    current_streak: 0,
    longest_streak: 0,
    type: 'none'
  };
} 