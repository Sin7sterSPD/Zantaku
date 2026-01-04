import { useEffect, useRef, useState, useCallback } from 'react';
import { 
  View, 
  StyleSheet, 
  StatusBar, 
  DeviceEventEmitter, 
  Platform, 
  Modal, 
  Text, 
  TouchableOpacity, 
  ActivityIndicator 
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import ExpoAvPlayer from '@components/ExpoAvPlayer';
import WebViewVideoPlayer from '@components/WebViewVideoPlayer';
import SubtitleOverlay from '@components/SubtitleOverlay';
import { useTheme } from '../../hooks/useTheme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { STORAGE_KEY, ANILIST_GRAPHQL_ENDPOINT } from '../../constants/auth';
import usePictureInPicture from '../../hooks/usePictureInPicture';

// =============================================================================
// TYPES
// =============================================================================

type Engine = 'webview' | 'expoav';

interface ZencloudData {
  m3u8_url: string;
  subtitles?: { format?: string }[];
  chapters?: unknown[];
}

interface VideoData {
  source: string;
  headers?: Record<string, string>;
  audioType?: 'sub' | 'dub';
  zencloudData?: ZencloudData;
}

interface PlayerSettings {
  pipEnabled: boolean;
  forceLandscape: boolean;
  saveToAniList: boolean;
}

interface AniListUser {
  userId: number;
  username: string;
  token: string;
  avatar?: string;
}

// =============================================================================
// ENGINE SELECTION
// =============================================================================

/**
 * Auto-select best player engine based on video data and platform.
 * - WebView: Multiple audio tracks via HLS, hls.js ABR, audioTrack switching
 * - ExpoAV: Lower overhead, native playback
 */
function decideEngine(data: VideoData | null): Engine {
  const hasZencloud = !!data?.zencloudData;
  
  // Android with Zencloud data → WebView (hls.js for multi-audio)
  if (Platform.OS === 'android' && hasZencloud) return 'webview';
  
  // iOS with Zencloud → native HLS is solid
  if (Platform.OS === 'ios' && hasZencloud) return 'expoav';
  
  // Default fallback
  return Platform.OS === 'ios' ? 'expoav' : 'webview';
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function Player() {
  const { isDarkMode } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams();
  
  // Refs
  const isLocked = useRef(false);
  const lockTimeout = useRef<NodeJS.Timeout | null>(null);
  const currentPlaybackPosition = useRef<number>(0);
  const videoDuration = useRef<number>(0);
  const pendingExit = useRef<boolean>(false);
  
  // PiP
  const { isSupported: isPipSupported, isInPipMode } = usePictureInPicture();
  
  // Core state
  const [isReady, setIsReady] = useState(false);
  const [engine, setEngine] = useState<Engine>('webview');
  const [playerSettings, setPlayerSettings] = useState<PlayerSettings>({
    pipEnabled: true,
    forceLandscape: true,
    saveToAniList: true,
  });
  
  // AniList
  const [anilistUser, setAnilistUser] = useState<AniListUser | null>(null);
  const [showExitModal, setShowExitModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Subtitle state
  const [videoData, setVideoData] = useState<VideoData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSubtitle, setSelectedSubtitle] = useState(0);
  const [subtitleSize, setSubtitleSize] = useState(18);
  const [subtitleOpacity, setSubtitleOpacity] = useState(1.0);
  const [subtitlePosition, setSubtitlePosition] = useState(0.85);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);

  // Auto-detect best player engine
  useEffect(() => {
    let mounted = true;
    const detectEngine = async () => {
      try {
        const key = params.dataKey as string;
        if (!key) return;
        
        const raw = await AsyncStorage.getItem(key);
        const parsed: VideoData | null = raw ? JSON.parse(raw) : null;
        if (!mounted) return;
        
        const selectedEngine = decideEngine(parsed);
        setEngine(selectedEngine);
        console.log('[PLAYER] Engine:', selectedEngine);
      } catch {
        // Keep default
      }
    };
    
    detectEngine();
    return () => { mounted = false; };
  }, [params.dataKey]);

  // Load video data and subtitle settings
  useEffect(() => {
    const loadData = async () => {
      try {
        const dataKey = params.dataKey as string;
        if (dataKey) {
          const storedData = await AsyncStorage.getItem(`videoData_${dataKey}`);
          if (storedData) {
            setVideoData(JSON.parse(storedData));
          }
        }
        
        // Load subtitle settings
        const stored = await AsyncStorage.getItem('playerSettings');
        if (stored) {
          const settings = JSON.parse(stored);
          setSelectedSubtitle(settings.selectedSubtitle || 0);
          setSubtitleSize(settings.subtitleSize || 18);
          setSubtitleOpacity(settings.subtitleOpacity ?? 1.0);
          setSubtitlePosition(settings.subtitlePosition || 0.85);
          setSubtitlesEnabled(settings.subtitlesEnabled !== false);
        }
      } catch {
        // Use defaults
      }
    };

    loadData();
  }, [params.dataKey]);

  // Handle time updates from WebView player
  const handleTimeUpdate = (time: number) => {
    setCurrentTime(time);
    currentPlaybackPosition.current = time;
  };

  // Listen for playback time updates from players
  useEffect(() => {
    const timeListener = DeviceEventEmitter.addListener('playerTimeUpdate', ({ currentTime, duration }: { currentTime: number; duration: number }) => {
      currentPlaybackPosition.current = currentTime;
      videoDuration.current = duration;
    });

    const durationListener = DeviceEventEmitter.addListener('playerDuration', (duration: number) => {
      videoDuration.current = duration;
    });

    return () => {
      timeListener.remove();
      durationListener.remove();
    };
  }, []);

  // Handle player errors with fallback
  const handlePlayerError = useCallback((error: string) => {
    console.error('[PLAYER] Error:', error);
    
    // Fallback to WebView if ExpoAV fails
    if (engine === 'expoav') {
      setEngine('webview');
    }
  }, [engine]);

  // Save progress to AniList
  const handleSaveToAniList = useCallback(async (episodeData: {
    anilistId: string;
    episodeNumber: number;
    currentTime: number;
    duration: number;
  }) => {
    if (!playerSettings.saveToAniList || !anilistUser || !episodeData.anilistId) {
      return false;
    }

    try {
      const mutation = `
        mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
          SaveMediaListEntry (mediaId: $mediaId, progress: $progress, status: $status) {
            id
            progress
            status
            media { title { userPreferred } }
          }
        }
      `;

      const response = await fetch(ANILIST_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${anilistUser.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            mediaId: parseInt(episodeData.anilistId),
            progress: episodeData.episodeNumber,
            status: 'CURRENT'
          }
        })
      });

      const data = await response.json();
      
      if (data.errors) {
        throw new Error(data.errors[0]?.message || 'Failed to save');
      }

      // Refresh app data
      DeviceEventEmitter.emit('refreshMediaLists');
      DeviceEventEmitter.emit('refreshWatchlist');

      return !!data.data?.SaveMediaListEntry;
    } catch (error) {
      console.error('[PLAYER] Save error:', error);
      throw error;
    }
  }, [playerSettings.saveToAniList, anilistUser]);

  // Load AniList user
  useEffect(() => {
    const loadUser = async () => {
      try {
        const token = await SecureStore.getItemAsync(STORAGE_KEY.AUTH_TOKEN);
        const userData = await SecureStore.getItemAsync(STORAGE_KEY.USER_DATA);
        
        if (token && userData) {
          const user = JSON.parse(userData);
          setAnilistUser({
            userId: user.id,
            username: user.name,
            token,
            avatar: user.avatar?.large
          });
        }
      } catch {
        // No user
      }
    };

    loadUser();
    
    const progressListener = DeviceEventEmitter.addListener('saveAniListProgress', handleSaveToAniList);
    return () => progressListener.remove();
  }, [handleSaveToAniList]);

  // Sync player preferences
  useEffect(() => {
    const loadPrefs = async () => {
      try {
        const stored = await AsyncStorage.getItem('playerPreferences');
        if (stored) {
          DeviceEventEmitter.emit('playerPreferencesHydrated', JSON.parse(stored));
        }
      } catch {
        // Ignore
      }
    };
    
    loadPrefs();
    const sub = DeviceEventEmitter.addListener('playerPreferencesChanged', loadPrefs);
    return () => sub.remove();
  }, []);

  // Load player settings
  useEffect(() => {
    let mounted = true;
    const loadSettings = async () => {
      try {
        const stored = await AsyncStorage.getItem('playerSettings');
        if (stored && mounted) {
          setPlayerSettings(prev => ({ ...prev, ...JSON.parse(stored) }));
        }
      } catch {
        // Use defaults
      }
    };
    
    loadSettings();
    const sub = DeviceEventEmitter.addListener('playerSettingsChanged', loadSettings);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Navigation
  const navigateBack = useCallback((shouldRefresh = false) => {
    if (params.anilistId) {
      router.replace({
        pathname: `/anime/[id]`,
        params: { 
          id: params.anilistId as string,
          tab: 'watch',
          refresh: shouldRefresh ? '1' : '0'
        }
      });
    } else {
      router.back();
    }
  }, [params.anilistId, router]);

  // Exit handling
  const handleExitRequest = useCallback(() => {
    if (!anilistUser || !playerSettings.saveToAniList) {
      navigateBack(false);
      return;
    }
    pendingExit.current = true;
    setShowExitModal(true);
  }, [anilistUser, playerSettings.saveToAniList, navigateBack]);

  const handleSaveAndExit = useCallback(async () => {
    if (!anilistUser || !params.anilistId || !params.episodeNumber) {
      navigateBack(false);
      return;
    }

    setIsSaving(true);
    try {
      await handleSaveToAniList({
        anilistId: params.anilistId as string,
        episodeNumber: parseInt(params.episodeNumber as string),
        currentTime: currentPlaybackPosition.current,
        duration: videoDuration.current
      });
      setShowExitModal(false);
      navigateBack(true);
    } catch {
      setShowExitModal(false);
      navigateBack(false);
    } finally {
      setIsSaving(false);
    }
  }, [anilistUser, params, handleSaveToAniList, navigateBack]);

  const handleExitWithoutSaving = useCallback(() => {
    setShowExitModal(false);
    navigateBack(true);
  }, [navigateBack]);

  const handleCancelExit = useCallback(() => {
    setShowExitModal(false);
    pendingExit.current = false;
  }, []);

  // Exit request listener
  useEffect(() => {
    const exitListener = DeviceEventEmitter.addListener('requestPlayerExit', handleExitRequest);
    return () => exitListener.remove();
  }, [handleExitRequest]);

  // Orientation handling
  useEffect(() => {
    let mounted = true;
    let subscription: ScreenOrientation.Subscription | null = null;

    const setupOrientation = async () => {
      if (!mounted || isLocked.current) return;
      
      if (!playerSettings.forceLandscape) {
        StatusBar.setHidden(false, 'fade');
        setIsReady(true);
        return;
      }
      
      try {
        StatusBar.setHidden(true, 'fade');
        await new Promise(r => setTimeout(r, 0));
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
        
        if (mounted) {
          isLocked.current = true;
          setIsReady(true);
        }
      } catch {
        if (mounted) setIsReady(true);
      }
    };

    setupOrientation();

    // Orientation change handler
    const handleOrientationChange = async (event: ScreenOrientation.OrientationChangeEvent) => {
      if (!mounted || !isLocked.current || isInPipMode || !playerSettings.forceLandscape) return;
      
      if (lockTimeout.current) clearTimeout(lockTimeout.current);

      lockTimeout.current = setTimeout(async () => {
        if (!mounted || isInPipMode) return;
        
        const orientation = event.orientationInfo.orientation;
        const isPortrait = orientation === ScreenOrientation.Orientation.PORTRAIT_UP || 
                          orientation === ScreenOrientation.Orientation.PORTRAIT_DOWN;
        
        if (isPortrait) {
          try {
            await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
          } catch {
            // Ignore
          }
        }
      }, 150);
    };

    if (playerSettings.forceLandscape) {
      setTimeout(() => {
        if (mounted) {
          subscription = ScreenOrientation.addOrientationChangeListener(handleOrientationChange);
        }
      }, 300);
    }

    return () => {
      mounted = false;
      isLocked.current = false;
      
      if (lockTimeout.current) {
        clearTimeout(lockTimeout.current);
        lockTimeout.current = null;
      }

      if (subscription) {
        ScreenOrientation.removeOrientationChangeListener(subscription);
      }
      
      // Restore orientation
      StatusBar.setHidden(false, 'fade');
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [playerSettings.forceLandscape, isInPipMode]);

  // Format time helper
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Loading state
  if (!isReady) {
    return (
      <View style={[styles.container, styles.loading, { backgroundColor: isDarkMode ? '#000' : '#fff' }]}>
        <StatusBar hidden={true} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDarkMode ? '#000' : '#fff' }]}>
      <StatusBar hidden={true} />
      
      {/* Player Component */}
      {engine === 'expoav' ? (
        <ExpoAvPlayer 
          onError={handlePlayerError}
          isPipSupported={isPipSupported}
          isInPipMode={isInPipMode}
        />
      ) : (
        <WebViewVideoPlayer 
          onTimeUpdate={handleTimeUpdate}
          isPipSupported={isPipSupported}
          isInPipMode={isInPipMode}
        />
      )}
      
      {/* Subtitle Overlay (WebView only) */}
      {engine !== 'expoav' && (
        <SubtitleOverlay
          isVisible={true}
          currentTime={currentTime}
          videoData={videoData}
          selectedSubtitle={selectedSubtitle}
          subtitleSize={subtitleSize}
          subtitleOpacity={subtitleOpacity}
          subtitlePosition={subtitlePosition}
          subtitlesEnabled={subtitlesEnabled}
        />
      )}

      {/* Exit Save Modal */}
      <Modal
        visible={showExitModal}
        transparent
        animationType="fade"
        onRequestClose={handleCancelExit}
      >
        <View style={exitModalStyles.overlay}>
          <View style={[exitModalStyles.modalBox, { backgroundColor: isDarkMode ? '#1C1C1E' : '#FFFFFF' }]}>
            <Text style={[exitModalStyles.title, { color: isDarkMode ? '#FFFFFF' : '#000000' }]}>
              Save Progress?
            </Text>
            <Text style={[exitModalStyles.message, { color: isDarkMode ? '#EBEBF5' : '#3C3C43' }]}>
              Save Episode {params.episodeNumber || '?'} at {formatTime(currentPlaybackPosition.current)}?
            </Text>
            
            {isSaving ? (
              <View style={exitModalStyles.savingContainer}>
                <ActivityIndicator size="small" color="#02A9FF" />
                <Text style={[exitModalStyles.savingText, { color: isDarkMode ? '#EBEBF5' : '#3C3C43' }]}>
                  Saving to AniList...
                </Text>
              </View>
            ) : (
              <View style={exitModalStyles.buttons}>
                <TouchableOpacity
                  style={[exitModalStyles.button, exitModalStyles.saveButton]}
                  onPress={handleSaveAndExit}
                >
                  <Text style={exitModalStyles.saveButtonText}>Yes, Save</Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={[exitModalStyles.button, exitModalStyles.leaveButton]}
                  onPress={handleExitWithoutSaving}
                >
                  <Text style={exitModalStyles.leaveButtonText}>No, Leave</Text>
                </TouchableOpacity>
                
                <TouchableOpacity
                  style={[exitModalStyles.button, exitModalStyles.cancelButton]}
                  onPress={handleCancelExit}
                >
                  <Text style={[exitModalStyles.cancelButtonText, { color: isDarkMode ? '#FFFFFF' : '#000000' }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});

const exitModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalBox: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  buttons: {
    gap: 12,
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveButton: {
    backgroundColor: '#02A9FF',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  leaveButton: {
    backgroundColor: '#FF3B30',
  },
  leaveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: 'rgba(120, 120, 128, 0.16)',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  savingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 20,
  },
  savingText: {
    fontSize: 16,
  },
});