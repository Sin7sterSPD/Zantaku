import { useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';

const STREAK_DATA_KEY_PREFIX = 'streak_data_'; // Prefix for per-user streak data

interface StreakData {
  anilist_id: number;
  last_active: string;
  current_streak: number;
  longest_streak: number;
  type: 'anime' | 'manga' | 'combo' | 'none';
}

export function useStreaks(anilistId?: number) {
  const [streakData, setStreakData] = useState<StreakData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadStreakData = async () => {
      if (!anilistId) {
        setIsLoading(false);
        return;
      }
      
      try {
        setIsLoading(true);
        setError(null);
        
        // Load streak data from local storage
        const storageKey = `${STREAK_DATA_KEY_PREFIX}${anilistId}`;
        const streakDataJson = await SecureStore.getItemAsync(storageKey);
        
        if (!streakDataJson) {
          console.log('No streak data found for user in local storage:', anilistId);
          setStreakData(null);
        } else {
          const data = JSON.parse(streakDataJson) as StreakData;
          console.log('Streak data loaded successfully from local storage:', {
            current_streak: data.current_streak,
            longest_streak: data.longest_streak
          });
          setStreakData(data);
        }
      } catch (err) {
        console.error('Error loading streak data from local storage:', err);
        setError('Failed to load streak data');
      } finally {
        setIsLoading(false);
      }
    };
    
    loadStreakData();
  }, [anilistId]);
  
  return {
    streakData,
    isLoading,
    error,
    currentStreak: streakData?.current_streak || 0,
    longestStreak: streakData?.longest_streak || 0,
    activityType: streakData?.type || 'none',
    lastActive: streakData?.last_active ? new Date(streakData.last_active) : null
  };
} 