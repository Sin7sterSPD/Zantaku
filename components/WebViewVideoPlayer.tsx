import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { 
  View, 
  Text, 
  TouchableOpacity, 
  StyleSheet, 
  Dimensions, 
  StatusBar, 
  ScrollView, 
  DeviceEventEmitter,
  Animated 
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';
import usePictureInPicture from '../hooks/usePictureInPicture';
import Slider from '@react-native-community/slider';

const { width, height } = Dimensions.get('window');

// =============================================================================
// TYPES
// =============================================================================

interface ZencloudSubtitle {
  url: string;
  language: string;
  language_name: string;
  format: string;
  is_default: boolean;
}

interface ZencloudChapter {
  id: string;
  title: string;
  start_time: number;
  end_time: number;
}

interface ZencloudFont {
  name: string;
  url: string;
}

interface ZencloudData {
  file_code: string;
  m3u8_url: string;
  original_filename: string;
  subtitles: ZencloudSubtitle[];
  chapters: ZencloudChapter[];
  fonts: ZencloudFont[];
  token: string;
  token_expires: string;
  client_ip: string;
  token_ip_bound: boolean;
}

interface VideoData {
  source: string;
  headers: Record<string, string>;
  episodeId: string;
  episodeNumber: number;
  subtitles: {
    url: string;
    lang: string;
  }[];
  timings: {
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  } | null;
  anilistId: string;
  animeTitle: string;
  provider: string;
  audioType: 'sub' | 'dub';
  zencloudData?: ZencloudData;
}

interface PlayerSettings {
  selectedSubtitle: number;
  selectedAudioTrack: number;
  playbackSpeed: number;
  subtitleSize: number;
  subtitleOpacity: number;
  subtitlePosition: number;
  subtitlesEnabled: boolean;
}

interface WebViewVideoPlayerProps {
  onTimeUpdate?: (time: number) => void;
  isPipSupported?: boolean;
  isInPipMode?: boolean;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

const debounce = <T extends unknown[]>(fn: (...args: T) => void, wait: number) => {
  let t: ReturnType<typeof setTimeout>;
  return (...args: T) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
};

const throttle = <T extends unknown[]>(fn: (...args: T) => void, limit: number) => {
  let inThrottle: boolean;
  return (...args: T) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
};

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

// =============================================================================
// SETTINGS SECTION COMPONENT
// =============================================================================

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ title, children }) => (
  <View style={styles.settingsSection}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {children}
  </View>
);

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function WebViewVideoPlayer({ 
  onTimeUpdate, 
  isPipSupported: propIsPipSupported, 
  isInPipMode: propIsInPipMode 
}: WebViewVideoPlayerProps) {
  const router = useRouter();
  const params = useLocalSearchParams();
  const webViewRef = useRef<WebView>(null);
  
  // Picture-in-Picture
  const { 
    isSupported: hookIsPipSupported, 
    isInPipMode: hookIsInPipMode, 
    enterPipMode 
  } = usePictureInPicture();
  const isPipSupported = propIsPipSupported ?? hookIsPipSupported;
  const isInPipMode = propIsInPipMode ?? hookIsInPipMode;
  
  // Video state
  const [videoData, setVideoData] = useState<VideoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  
  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'subtitles' | 'playback' | 'audio'>('subtitles');
  const [selectedSubtitle, setSelectedSubtitle] = useState(0);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [subtitleSize, setSubtitleSize] = useState(18);
  const [subtitleOpacity, setSubtitleOpacity] = useState(1.0);
  const [subtitlePosition, setSubtitlePosition] = useState(0.85);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  
  // Chapter menu state
  const [showChapterMenu, setShowChapterMenu] = useState(false);
  const [chapterMenuPosition, setChapterMenuPosition] = useState({ x: 0, y: 0 });

  // Progress bar refs
  const progressRef = useRef<View>(null);
  const [progressBarWidth, setProgressBarWidth] = useState(width - 120);
  const lastSeekTime = useRef(0);
  const isScrubbingRef = useRef(false);

  // =============================================================================
  // DEBOUNCED SETTINGS SAVE
  // =============================================================================

  const saveSettingsDebounced = useRef(
    debounce(async (settings: PlayerSettings) => {
      try {
        await AsyncStorage.setItem('playerSettings', JSON.stringify(settings));
      } catch {
        // Silent fail
      }
    }, 500)
  ).current;

  // =============================================================================
  // LOAD VIDEO DATA
  // =============================================================================

  useEffect(() => {
    const loadVideoData = async () => {
      try {
        const dataKey = params.dataKey as string;
        if (!dataKey) {
          throw new Error('No data key provided');
        }

        const storedData = await AsyncStorage.getItem(dataKey);
        if (!storedData) {
          throw new Error('No video data found');
        }

        const data: VideoData = JSON.parse(storedData);
        console.log('[PLAYER] ✅ Loaded video data:', data.animeTitle);

        setVideoData(data);
        setLoading(false);
      } catch (err) {
        console.error('[PLAYER] ❌ Error loading video data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load video data');
        setLoading(false);
      }
    };

    loadVideoData();
  }, [params.dataKey]);

  // =============================================================================
  // LOAD/SAVE SETTINGS
  // =============================================================================

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const stored = await AsyncStorage.getItem('playerSettings');
        if (stored) {
          const settings: PlayerSettings = JSON.parse(stored);
          setSelectedSubtitle(settings.selectedSubtitle || 0);
          setSelectedAudioTrack(settings.selectedAudioTrack || 0);
          setPlaybackSpeed(settings.playbackSpeed || 1.0);
          setSubtitleSize(settings.subtitleSize || 18);
          setSubtitleOpacity(settings.subtitleOpacity ?? 1.0);
          setSubtitlePosition(settings.subtitlePosition || 0.85);
          setSubtitlesEnabled(settings.subtitlesEnabled !== false);
        }
      } catch {
        // Use defaults
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    saveSettingsDebounced({
      selectedSubtitle,
      selectedAudioTrack,
      playbackSpeed,
      subtitleSize,
      subtitleOpacity,
      subtitlePosition,
      subtitlesEnabled
    });
  }, [selectedSubtitle, selectedAudioTrack, playbackSpeed, subtitleSize, subtitleOpacity, subtitlePosition, subtitlesEnabled, saveSettingsDebounced]);

  // =============================================================================
  // WEBVIEW COMMANDS
  // =============================================================================

  const sendCommand = useCallback((command: Record<string, unknown>) => {
    if (webViewRef.current) {
      try {
        webViewRef.current.postMessage(JSON.stringify(command));
      } catch {
        // Silent fail
      }
    }
  }, []);

  // Send audio track to WebView
  useEffect(() => {
    if (webViewRef.current && videoData) {
      setTimeout(() => {
        sendCommand({ type: 'setAudioTrack', trackIndex: selectedAudioTrack });
      }, 500);
    }
  }, [selectedAudioTrack, videoData, sendCommand]);

  // Send subtitle track to WebView
  useEffect(() => {
    if (webViewRef.current && videoData) {
      sendCommand({ type: 'setSubtitleTrack', trackIndex: selectedSubtitle });
    }
  }, [selectedSubtitle, videoData, sendCommand]);

  // Send subtitle styling to WebView
  useEffect(() => {
    if (webViewRef.current && videoData) {
      sendCommand({ 
        type: 'setSubtitleStyle', 
        size: subtitleSize,
        opacity: subtitleOpacity,
        position: subtitlePosition,
        enabled: subtitlesEnabled
      });
    }
  }, [subtitleSize, subtitleOpacity, subtitlePosition, subtitlesEnabled, videoData, sendCommand]);

  // =============================================================================
  // CLEANUP
  // =============================================================================

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  // =============================================================================
  // CONTROLS VISIBILITY
  // =============================================================================

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      Animated.timing(controlsOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => setShowControls(false));
    }, 3500);
  }, [controlsOpacity]);

  // =============================================================================
  // THROTTLED POSITION UPDATE
  // =============================================================================

  const throttledSetPosition = useRef(
    throttle((pos: number) => {
      setPosition(pos);
    }, 100)
  ).current;

  // =============================================================================
  // WEBVIEW MESSAGE HANDLER
  // =============================================================================

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      switch (data.type) {
        case 'playbackStatus':
          if (data.position !== undefined) {
            throttledSetPosition(data.position);
            onTimeUpdate?.(data.position);
            
            if (data.duration !== undefined && data.duration > 0) {
              DeviceEventEmitter.emit('playerTimeUpdate', {
                currentTime: data.position,
                duration: data.duration
              });
            }
          }
          if (data.isPlaying !== undefined) {
            setIsPlaying(data.isPlaying);
          }
          if (data.duration !== undefined && !isNaN(data.duration) && data.duration > 0) {
            setDuration(prev => {
              if (data.duration !== prev) {
                DeviceEventEmitter.emit('playerDuration', data.duration);
                return data.duration;
              }
              return prev;
            });
          }
          break;
        case 'error':
          console.error('[PLAYER] ❌ Video error:', data.message);
          setError(data.message);
          break;
        case 'ready':
          console.log('[PLAYER] ✅ Video player ready');
          break;
      }
    } catch {
      // Silent fail
    }
  }, [onTimeUpdate, throttledSetPosition]);

  // =============================================================================
  // PLAYBACK CONTROLS
  // =============================================================================

  const togglePlayPause = useCallback(() => {
    sendCommand({ type: 'togglePlayPause' });
    showControlsTemporarily();
  }, [sendCommand, showControlsTemporarily]);

  const seekTo = useCallback((seconds: number) => {
    setPosition(seconds);
    sendCommand({ type: 'seekTo', position: seconds });
    showControlsTemporarily();
  }, [sendCommand, showControlsTemporarily]);

  const skip = useCallback((seconds: number) => {
    const newPosition = position + seconds;
    seekTo(newPosition);
  }, [position, seekTo]);

  const setPlaybackRate = useCallback((rate: number) => {
    sendCommand({ type: 'setPlaybackRate', rate });
  }, [sendCommand]);

  useEffect(() => {
    if (videoData) {
      setPlaybackRate(playbackSpeed);
    }
  }, [playbackSpeed, videoData, setPlaybackRate]);

  // =============================================================================
  // PIP HANDLER
  // =============================================================================

  const handleEnterPip = useCallback(async () => {
    if (!isPipSupported) return;

    try {
      const success = await enterPipMode({ width: 16, height: 9 });
      if (success && !isPlaying) {
        sendCommand({ type: 'togglePlayPause' });
      }
    } catch (error) {
      console.error('[PLAYER] ❌ Error entering PiP mode:', error);
    }
  }, [isPipSupported, enterPipMode, isPlaying, sendCommand]);

  // =============================================================================
  // PROGRESS BAR HANDLERS
  // =============================================================================

  const percentFromX = useCallback((x: number) => {
    if (!progressBarWidth || duration <= 0) return 0;
    return Math.max(0, Math.min(1, x / progressBarWidth));
  }, [progressBarWidth, duration]);

  const seekToPercent = useCallback((p: number) => {
    const target = p * (duration || 0);
    setPosition(target);
    
    const now = Date.now();
    if (now - lastSeekTime.current > 150) {
      sendCommand({ type: 'seekTo', position: target });
      lastSeekTime.current = now;
    }
    
    showControlsTemporarily();
  }, [duration, sendCommand, showControlsTemporarily]);

  const handleResponderGrant = useCallback((event: { nativeEvent: { locationX: number; pageX: number; pageY: number } }) => {
    if (!duration || duration <= 0) return;
    isScrubbingRef.current = true;
    sendCommand({ type: 'beginScrub' });
    const p = percentFromX(event.nativeEvent.locationX);
    seekToPercent(p);
    
    if (videoData?.zencloudData?.chapters && videoData.zencloudData.chapters.length > 0) {
      setChapterMenuPosition({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
      setShowChapterMenu(true);
    }
  }, [duration, percentFromX, seekToPercent, sendCommand, videoData]);

  const handleResponderMove = useCallback((event: { nativeEvent: { locationX: number } }) => {
    if (!isScrubbingRef.current) return;
    const p = percentFromX(event.nativeEvent.locationX);
    seekToPercent(p);
  }, [percentFromX, seekToPercent]);

  const handleResponderRelease = useCallback((event: { nativeEvent: { locationX: number } }) => {
    if (!isScrubbingRef.current) return;
    
    const p = percentFromX(event.nativeEvent.locationX);
    const target = p * duration;
    
    setPosition(target);
    sendCommand({ type: 'seekTo', position: target });
    sendCommand({ type: 'endScrub' });
    
    isScrubbingRef.current = false;
    setShowChapterMenu(false);
    showControlsTemporarily();
  }, [percentFromX, duration, sendCommand, showControlsTemporarily]);

  // =============================================================================
  // HTML GENERATION
  // =============================================================================

  const generateHTML = useMemo(() => {
    if (!videoData) return '';

    const videoUrl = videoData.zencloudData?.m3u8_url || videoData.source;
    const subtitles = videoData.zencloudData?.subtitles || [];

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { background: #000; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          #videoContainer { position: relative; width: 100vw; height: 100vh; background: #000; }
          #video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            outline: none;
            border: none;
          }
          #video::-webkit-media-controls,
          #video::-webkit-media-controls-panel,
          #video::-webkit-media-controls-play-button,
          #video::-webkit-media-controls-timeline,
          #video::-webkit-media-controls-current-time-display,
          #video::-webkit-media-controls-time-remaining-display,
          #video::-webkit-media-controls-mute-button,
          #video::-webkit-media-controls-volume-slider,
          #video::-webkit-media-controls-fullscreen-button,
          video::-webkit-media-controls-overlay-play-button,
          video::-webkit-media-controls-enclosure { display: none !important; }
          video::-moz-media-controls { display: none !important; }
          video::-ms-media-controls { display: none !important; }
          
          /* Subtitle styling */
          ::cue {
            background: rgba(0, 0, 0, var(--subtitle-bg-opacity, 0.75));
            color: white;
            font-size: var(--subtitle-size, 18px);
            font-weight: 500;
            padding: 4px 8px;
            border-radius: 4px;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
          }
        </style>
      </head>
      <body>
        <div id="videoContainer">
          <video id="video" preload="metadata" playsinline></video>
        </div>

        <script>
          const video = document.getElementById('video');
          video.controls = false;
          video.controlsList = 'nodownload nofullscreen noremoteplayback';
          video.disablePictureInPicture = true;
          
          let subtitleSize = 18;
          let subtitleOpacity = 1.0;
          let subtitlePosition = 0.85;
          let subtitlesEnabled = true;
          
          function sendMessage(message) {
            window.ReactNativeWebView.postMessage(JSON.stringify(message));
          }
          
          function formatTime(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            if (hours > 0) {
              return hours + ':' + minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
            }
            return minutes + ':' + secs.toString().padStart(2, '0');
          }
          
          // Optimized timeupdate
          let lastSentPos = -1;
          let lastIsPlaying = null;
          const SEND_INTERVAL_MS = 500;
          let lastSend = 0;
          
          video.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastSend < SEND_INTERVAL_MS) return;
            lastSend = now;

            const pos = video.currentTime;
            if (Math.abs(pos - lastSentPos) < 0.25 && lastIsPlaying === !video.paused) return;

            lastSentPos = pos;
            lastIsPlaying = !video.paused;
            sendMessage({ type: 'playbackStatus', isPlaying: lastIsPlaying, position: pos, duration: video.duration || 0 });
          });
          
          video.addEventListener('loadedmetadata', () => {
            sendMessage({ type: 'playbackStatus', isPlaying: false, position: 0, duration: video.duration });
          });
          
          video.addEventListener('play', () => {
            sendMessage({ type: 'playbackStatus', isPlaying: true, position: video.currentTime, duration: video.duration });
          });
          
          video.addEventListener('pause', () => {
            sendMessage({ type: 'playbackStatus', isPlaying: false, position: video.currentTime, duration: video.duration });
          });
          
          video.addEventListener('seeked', () => {
            sendMessage({ type: 'playbackStatus', isPlaying: !video.paused, position: video.currentTime, duration: video.duration });
          });
          
          video.addEventListener('error', (e) => {
            sendMessage({ type: 'error', message: 'Video playback error: ' + (video.error?.message || 'Unknown error') });
          });
          
          // Message handler
          function __bridgeHandler(evt) {
            try {
              const command = JSON.parse(evt.data);
              handleCommand(command);
            } catch (e) {}
          }
          window.addEventListener('message', __bridgeHandler);
          document.addEventListener('message', __bridgeHandler);
          
          let wasPlayingBeforeScrub = false;
          
          function handleCommand(command) {
            switch (command.type) {
              case 'togglePlayPause':
                if (video.paused) {
                  video.play().catch(() => {
                    try {
                      const t = video.currentTime;
                      video.currentTime = Math.max(0, t - 0.001);
                      video.play().catch(() => {});
                    } catch {}
                  });
                } else {
                  video.pause();
                }
                break;
              case 'beginScrub':
                wasPlayingBeforeScrub = !video.paused;
                if (wasPlayingBeforeScrub) video.pause();
                break;
              case 'endScrub':
                if (wasPlayingBeforeScrub) video.play().catch(() => {});
                wasPlayingBeforeScrub = false;
                break;
              case 'seekTo': {
                const t = Math.max(0, Math.min(video.duration || 0, command.position || 0));
                video.currentTime = t;
                break;
              }
              case 'setPlaybackRate':
                video.playbackRate = command.rate;
                break;
              case 'setAudioTrack':
                if (hls && hls.audioTracks && hls.audioTracks.length > command.trackIndex) {
                  hls.audioTrack = command.trackIndex;
                }
                break;
              case 'setSubtitleTrack':
                if (video.textTracks && video.textTracks.length > command.trackIndex) {
                  for (let i = 0; i < video.textTracks.length; i++) {
                    video.textTracks[i].mode = i === command.trackIndex ? 'showing' : 'hidden';
                  }
                }
                break;
              case 'setSubtitleStyle':
                subtitleSize = command.size || 18;
                subtitleOpacity = command.opacity ?? 1.0;
                subtitlePosition = command.position || 0.85;
                subtitlesEnabled = command.enabled !== false;
                
                document.documentElement.style.setProperty('--subtitle-size', subtitleSize + 'px');
                document.documentElement.style.setProperty('--subtitle-bg-opacity', (subtitleOpacity * 0.75).toFixed(2));
                
                // Toggle subtitle visibility
                if (video.textTracks) {
                  for (let i = 0; i < video.textTracks.length; i++) {
                    if (!subtitlesEnabled) {
                      video.textTracks[i].mode = 'hidden';
                    }
                  }
                }
                break;
            }
          }
          
          // HLS.js initialization
          let hls;
          const trackBlobUrls = [];
          const videoUrl = '${videoUrl}';
          const subtitles = ${JSON.stringify(subtitles)};
          
          // ASS to VTT conversion
          function convertASSToVTT(assText) {
            const lines = assText.split('\\n');
            let inEvents = false;
            let fmt = [];
            const cues = [];
            
            for (const raw of lines) {
              const line = raw.trim();
              if (line === '[Events]') { inEvents = true; continue; }
              if (inEvents && line.startsWith('Format:')) {
                fmt = line.slice(7).split(',').map(s => s.trim());
                continue;
              }
              if (inEvents && line.startsWith('Dialogue:')) {
                const payload = line.slice(9).split(',');
                const idx = (name) => Math.max(0, fmt.indexOf(name));
                const start = parseASSTime(payload[idx('Start')] || payload[1]);
                const end = parseASSTime(payload[idx('End')] || payload[2]);
                const text = payload.slice(idx('Text') || 9).join(',')
                  .replace(/\\{[^}]*\\}/g, '')
                  .replace(/\\\\N/g, '\\n')
                  .replace(/\\\\n/g, '\\n')
                  .trim();
                
                if (!isNaN(start) && !isNaN(end) && end > start && text) {
                  cues.push({ start, end, text });
                }
              } else if (inEvents && line.startsWith('[')) {
                break;
              }
            }
            
            let vtt = 'WEBVTT\\n\\n';
            let i = 1;
            for (const cue of cues) {
              vtt += i++ + '\\n';
              vtt += formatVTTTime(cue.start) + ' --> ' + formatVTTTime(cue.end) + '\\n';
              vtt += cue.text + '\\n\\n';
            }
            
            return vtt;
          }
          
          function parseASSTime(t) {
            const m = (t || '').trim().match(/(\\d+):(\\d{2}):(\\d{2})[.,](\\d{2})/);
            if (!m) return NaN;
            return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          }
          
          function formatVTTTime(sec) {
            const h = String(Math.floor(sec / 3600)).padStart(2, '0');
            const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
            const s = String(Math.floor(sec % 60)).padStart(2, '0');
            const ms = String(Math.floor((sec % 1) * 1000)).padStart(3, '0');
            return h + ':' + m + ':' + s + '.' + ms;
          }
          
          async function loadSubtitles() {
            const oldTracks = video.querySelectorAll('track');
            oldTracks.forEach(t => t.remove());
            while (trackBlobUrls.length) {
              try { URL.revokeObjectURL(trackBlobUrls.pop()); } catch (e) {}
            }
            
            if (subtitles.length === 0) return;
            
            for (let i = 0; i < subtitles.length; i++) {
              const subtitle = subtitles[i];
              try {
                const response = await fetch(subtitle.url);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                
                let vttContent = await response.text();
                
                if (subtitle.format === 'ass') {
                  vttContent = convertASSToVTT(vttContent);
                }
                
                const blob = new Blob([vttContent], { type: 'text/vtt' });
                const blobUrl = URL.createObjectURL(blob);
                trackBlobUrls.push(blobUrl);
                
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.src = blobUrl;
                track.srclang = subtitle.language || 'en';
                track.label = subtitle.language_name || subtitle.language || 'Unknown';
                track.default = (i === 0 || subtitle.is_default);
                
                video.appendChild(track);
              } catch (error) {
                console.error('Failed to load subtitle track', i, error);
              }
            }
          }
          
          function initializeVideo() {
            if (Hls.isSupported()) {
              hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 15,
                maxBufferLength: 12,
                maxMaxBufferLength: 18,
                maxBufferSize: 20 * 1000 * 1000,
                capLevelOnFPSDrop: true,
                capLevelToPlayerSize: true,
                manifestLoadingTimeOut: 8000,
                manifestLoadingMaxRetry: 2,
                levelLoadingTimeOut: 8000,
                levelLoadingMaxRetry: 2,
                fragLoadingTimeOut: 15000,
                fragLoadingMaxRetry: 2,
                maxBufferHole: 0.5,
                startPosition: -1,
                enableSoftwareAES: true
              });
              
              hls.loadSource(videoUrl);
              hls.attachMedia(video);
              
              hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                  switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                      hls.startLoad();
                      break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                      hls.recoverMediaError();
                      break;
                    default:
                      sendMessage({ type: 'error', message: 'HLS playback error: ' + data.details });
                      break;
                  }
                }
              });
              
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                hls.autoLevelCapping = 3;
                loadSubtitles();
                sendMessage({ type: 'ready' });
                
                const checkDuration = () => {
                  if (video.duration && video.duration > 0) {
                    sendMessage({ type: 'playbackStatus', isPlaying: false, position: 0, duration: video.duration });
                  } else {
                    setTimeout(checkDuration, 100);
                  }
                };
                checkDuration();
                
                video.play().catch(() => {});
              });
              
              hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
                if (!data.details.live && video.duration > 0) {
                  sendMessage({ type: 'playbackStatus', isPlaying: !video.paused, position: video.currentTime, duration: video.duration });
                }
              });
              
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = videoUrl;
              video.playsInline = true;
              
              video.addEventListener('loadedmetadata', () => {
                loadSubtitles();
                sendMessage({ type: 'ready' });
                video.play().catch(() => {});
              });
            } else {
              sendMessage({ type: 'error', message: 'HLS playback not supported on this device' });
            }
          }
          
          window.addEventListener('beforeunload', () => {
            if (hls) hls.destroy();
            while (trackBlobUrls.length) {
              try { URL.revokeObjectURL(trackBlobUrls.pop()); } catch (e) {}
            }
          });
          
          initializeVideo();
        </script>
      </body>
      </html>
    `;
  }, [videoData]);

  // =============================================================================
  // RENDER - LOADING STATE
  // =============================================================================

  if (loading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <StatusBar hidden translucent backgroundColor="transparent" />
        <View style={styles.loadingSpinner}>
          <Text style={styles.loadingText}>Loading video...</Text>
        </View>
      </View>
    );
  }

  // =============================================================================
  // RENDER - ERROR STATE
  // =============================================================================

  if (error || !videoData) {
    return (
      <View style={[styles.container, styles.errorContainer]}>
        <StatusBar hidden translucent backgroundColor="transparent" />
        <View style={styles.errorBox}>
          <FontAwesome5 name="exclamation-triangle" size={40} color="#ff4444" />
          <Text style={styles.errorText}>{error || 'Failed to load video'}</Text>
          <TouchableOpacity style={styles.errorBackButton} onPress={() => router.back()}>
            <Text style={styles.errorBackButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // =============================================================================
  // RENDER - MAIN PLAYER
  // =============================================================================

  const progressPercent = duration > 0 ? (position / duration) * 100 : 0;
  const hasChapters = videoData.zencloudData?.chapters && videoData.zencloudData.chapters.length > 0;
  const hasSubtitles = videoData.zencloudData?.subtitles && videoData.zencloudData.subtitles.length > 0;

  return (
    <View style={styles.container}>
      <StatusBar hidden translucent backgroundColor="transparent" />
      
      {/* WebView Video Player */}
      <TouchableOpacity 
        style={styles.videoContainer} 
        activeOpacity={1} 
        onPress={showControlsTemporarily}
      >
        <WebView
          ref={webViewRef}
          source={{ html: generateHTML }}
          style={styles.webview}
          onMessage={handleWebViewMessage}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          scalesPageToFit={false}
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          allowsFullscreenVideo={true}
          allowsBackForwardNavigationGestures={false}
          cacheEnabled={true}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          mixedContentMode="compatibility"
          androidLayerType="hardware"
          overScrollMode="never"
          nestedScrollEnabled={false}
          keyboardDisplayRequiresUserAction={false}
          onShouldStartLoadWithRequest={() => true}
          removeClippedSubviews={true}
          renderToHardwareTextureAndroid={true}
          setSupportMultipleWindows={false}
        />
        
        {/* Controls Overlay */}
        {showControls && (
          <Animated.View style={[styles.controlsOverlay, { opacity: controlsOpacity }]}>
            {/* Top Bar */}
            <View style={styles.topBar}>
              <TouchableOpacity 
                style={styles.iconButton} 
                onPress={() => DeviceEventEmitter.emit('requestPlayerExit')}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome5 name="arrow-left" size={18} color="#fff" />
              </TouchableOpacity>
              
              <View style={styles.titleContainer}>
                <Text style={styles.videoTitle} numberOfLines={1}>
                  {videoData.animeTitle}
                </Text>
                <Text style={styles.episodeTitle} numberOfLines={1}>
                  Episode {videoData.episodeNumber}
                </Text>
              </View>
              
              <View style={styles.topRightControls}>
                {isPipSupported && (
                  <TouchableOpacity 
                    style={[styles.iconButton, isInPipMode && styles.iconButtonActive]} 
                    onPress={handleEnterPip}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <FontAwesome5 name="compress" size={16} color={isInPipMode ? "#02A9FF" : "#fff"} />
                  </TouchableOpacity>
                )}
                
                <TouchableOpacity 
                  style={[styles.iconButton, subtitlesEnabled && styles.iconButtonActive]}
                  onPress={() => setSubtitlesEnabled(!subtitlesEnabled)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <FontAwesome5 name="closed-captioning" size={16} color={subtitlesEnabled ? "#FFD700" : "#fff"} />
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={styles.iconButton} 
                  onPress={() => setShowSettings(true)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <FontAwesome5 name="cog" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Center Controls */}
            <View style={styles.centerControls}>
              <TouchableOpacity style={styles.skipButton} onPress={() => skip(-10)}>
                <FontAwesome5 name="backward" size={22} color="#fff" />
                <Text style={styles.skipText}>10</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.playButton} onPress={togglePlayPause}>
                <FontAwesome5 name={isPlaying ? "pause" : "play"} size={28} color="#fff" />
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.skipButton} onPress={() => skip(10)}>
                <FontAwesome5 name="forward" size={22} color="#fff" />
                <Text style={styles.skipText}>10</Text>
              </TouchableOpacity>
            </View>

            {/* Bottom Bar */}
            <View style={styles.bottomBar}>
              <Text style={styles.timeText}>{formatTime(position)}</Text>
              
              <View style={styles.progressContainer}>
                <View
                  ref={progressRef}
                  style={styles.progressBar}
                  onLayout={e => setProgressBarWidth(e.nativeEvent.layout.width)}
                  onStartShouldSetResponder={() => true}
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={handleResponderGrant}
                  onResponderMove={handleResponderMove}
                  onResponderRelease={handleResponderRelease}
                  onResponderTerminationRequest={() => true}
                >
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
                    
                    {/* Chapter markers */}
                    {hasChapters && videoData.zencloudData!.chapters.map((chapter) => {
                      if (chapter.start_time === 0) return null;
                      const chapterPercent = (chapter.start_time / duration) * 100;
                      return (
                        <View
                          key={chapter.id}
                          style={[styles.chapterMarker, { left: `${chapterPercent}%` }]}
                        />
                      );
                    })}
                    
                    <View style={[styles.progressThumb, { left: `${progressPercent}%` }]} />
                  </View>
                </View>
              </View>
              
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>
          </Animated.View>
        )}
      </TouchableOpacity>

      {/* Chapter Menu Popup */}
      {showChapterMenu && hasChapters && (
        <View style={styles.chapterMenuOverlay} pointerEvents="box-none">
          <View style={[
            styles.chapterMenuContainer, 
            { 
              top: Math.max(60, chapterMenuPosition.y - 200), 
              left: Math.min(Math.max(20, chapterMenuPosition.x - 100), width - 220) 
            }
          ]}>
            <Text style={styles.chapterMenuTitle}>Chapters</Text>
            <ScrollView style={styles.chapterMenuScroll} showsVerticalScrollIndicator={false}>
              {videoData.zencloudData!.chapters.map((chapter) => (
                <TouchableOpacity
                  key={chapter.id}
                  style={styles.chapterMenuItem}
                  onPress={() => {
                    seekTo(chapter.start_time);
                    setShowChapterMenu(false);
                  }}
                >
                  <Text style={styles.chapterMenuItemTitle} numberOfLines={1}>{chapter.title}</Text>
                  <Text style={styles.chapterMenuItemTime}>
                    {formatTime(chapter.start_time)} - {formatTime(chapter.end_time)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <View style={styles.settingsModal}>
          <TouchableOpacity 
            style={styles.settingsBackdrop} 
            activeOpacity={1} 
            onPress={() => setShowSettings(false)} 
          />
          <View style={styles.settingsContent}>
            {/* Header */}
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsTitle}>Settings</Text>
              <TouchableOpacity 
                onPress={() => setShowSettings(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <FontAwesome5 name="times" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
            
            {/* Tab Bar */}
            <View style={styles.settingsTabBar}>
              {(['subtitles', 'playback', 'audio'] as const).map(tab => (
                <TouchableOpacity
                  key={tab}
                  style={[styles.settingsTab, settingsTab === tab && styles.settingsTabActive]}
                  onPress={() => setSettingsTab(tab)}
                >
                  <FontAwesome5 
                    name={tab === 'subtitles' ? 'closed-captioning' : tab === 'playback' ? 'play-circle' : 'volume-up'} 
                    size={14} 
                    color={settingsTab === tab ? '#02A9FF' : '#888'} 
                  />
                  <Text style={[styles.settingsTabText, settingsTab === tab && styles.settingsTabTextActive]}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            
            <ScrollView 
              style={styles.settingsBody}
              showsVerticalScrollIndicator={true}
              bounces={true}
              contentContainerStyle={styles.settingsScrollContent}
            >
              {/* Subtitles Tab */}
              {settingsTab === 'subtitles' && (
                <>
                  {/* Enable/Disable */}
                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>Show Subtitles</Text>
                    <TouchableOpacity
                      style={[styles.toggleButton, subtitlesEnabled && styles.toggleButtonActive]}
                      onPress={() => setSubtitlesEnabled(!subtitlesEnabled)}
                    >
                      <Text style={styles.toggleButtonText}>{subtitlesEnabled ? 'ON' : 'OFF'}</Text>
                    </TouchableOpacity>
                  </View>
                  
                  {/* Language Selection */}
                  {hasSubtitles && (
                    <SettingsSection title="Language">
                      <View style={styles.optionsGrid}>
                        {videoData.zencloudData!.subtitles.reduce((acc, subtitle, index) => {
                          const language = subtitle.language_name || subtitle.language;
                          if (!acc.find(item => item.language === language)) {
                            acc.push({ language, index });
                          }
                          return acc;
                        }, [] as { language: string; index: number }[]).map(({ language, index }) => (
                          <TouchableOpacity
                            key={index}
                            style={[styles.optionButton, selectedSubtitle === index && styles.optionButtonSelected]}
                            onPress={() => setSelectedSubtitle(index)}
                          >
                            <Text style={[styles.optionText, selectedSubtitle === index && styles.optionTextSelected]}>
                              {language}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </SettingsSection>
                  )}
                  
                  {/* Subtitle Size */}
                  <SettingsSection title={`Size: ${subtitleSize}px`}>
                    <View style={styles.sliderContainer}>
                      <Text style={styles.sliderLabel}>12</Text>
                      <Slider
                        style={styles.slider}
                        minimumValue={12}
                        maximumValue={32}
                        step={1}
                        value={subtitleSize}
                        onValueChange={setSubtitleSize}
                        minimumTrackTintColor="#02A9FF"
                        maximumTrackTintColor="rgba(255,255,255,0.3)"
                        thumbTintColor="#02A9FF"
                      />
                      <Text style={styles.sliderLabel}>32</Text>
                    </View>
                  </SettingsSection>
                  
                  {/* Subtitle Opacity */}
                  <SettingsSection title={`Background Opacity: ${Math.round(subtitleOpacity * 100)}%`}>
                    <View style={styles.sliderContainer}>
                      <Text style={styles.sliderLabel}>0%</Text>
                      <Slider
                        style={styles.slider}
                        minimumValue={0}
                        maximumValue={1}
                        step={0.1}
                        value={subtitleOpacity}
                        onValueChange={setSubtitleOpacity}
                        minimumTrackTintColor="#02A9FF"
                        maximumTrackTintColor="rgba(255,255,255,0.3)"
                        thumbTintColor="#02A9FF"
                      />
                      <Text style={styles.sliderLabel}>100%</Text>
                    </View>
                  </SettingsSection>
                  
                  {/* Subtitle Position */}
                  <SettingsSection title={`Position: ${subtitlePosition < 0.5 ? 'Top' : subtitlePosition > 0.7 ? 'Bottom' : 'Middle'}`}>
                    <View style={styles.optionsGrid}>
                      {[
                        { label: 'Top', value: 0.15 },
                        { label: 'Middle', value: 0.5 },
                        { label: 'Bottom', value: 0.85 },
                      ].map(({ label, value }) => (
                        <TouchableOpacity
                          key={label}
                          style={[styles.optionButton, Math.abs(subtitlePosition - value) < 0.1 && styles.optionButtonSelected]}
                          onPress={() => setSubtitlePosition(value)}
                        >
                          <Text style={[styles.optionText, Math.abs(subtitlePosition - value) < 0.1 && styles.optionTextSelected]}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </SettingsSection>
                </>
              )}
              
              {/* Playback Tab */}
              {settingsTab === 'playback' && (
                <SettingsSection title="Playback Speed">
                  <View style={styles.optionsGrid}>
                    {[0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((speed) => (
                      <TouchableOpacity
                        key={speed}
                        style={[styles.optionButton, playbackSpeed === speed && styles.optionButtonSelected]}
                        onPress={() => setPlaybackSpeed(speed)}
                      >
                        <Text style={[styles.optionText, playbackSpeed === speed && styles.optionTextSelected]}>
                          {speed}x
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </SettingsSection>
              )}
              
              {/* Audio Tab */}
              {settingsTab === 'audio' && (
                <SettingsSection title="Audio Track">
                  <View style={styles.optionsGrid}>
                    <TouchableOpacity
                      style={[styles.optionButton, styles.optionButtonWide, selectedAudioTrack === 0 && styles.optionButtonSelected]}
                      onPress={() => setSelectedAudioTrack(0)}
                    >
                      <Text style={[styles.optionText, selectedAudioTrack === 0 && styles.optionTextSelected]}>
                        {videoData.audioType === 'sub' ? 'Japanese (Original)' : 'English (Dub)'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.optionButton, styles.optionButtonWide, selectedAudioTrack === 1 && styles.optionButtonSelected]}
                      onPress={() => setSelectedAudioTrack(1)}
                    >
                      <Text style={[styles.optionText, selectedAudioTrack === 1 && styles.optionTextSelected]}>
                        {videoData.audioType === 'sub' ? 'English (Dub)' : 'Japanese (Original)'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </SettingsSection>
              )}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

// =============================================================================
// STYLES
// =============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingSpinner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    marginTop: 12,
  },
  errorContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorBox: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 68, 68, 0.1)',
    padding: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 68, 0.3)',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 24,
    lineHeight: 22,
  },
  errorBackButton: {
    backgroundColor: '#02A9FF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  errorBackButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  videoContainer: {
    flex: 1,
    position: 'relative',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
  controlsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  
  // Top Bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  titleContainer: {
    flex: 1,
    marginHorizontal: 12,
  },
  videoTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  episodeTitle: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '400',
    marginTop: 2,
  },
  topRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    padding: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonActive: {
    backgroundColor: 'rgba(2, 169, 255, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(2, 169, 255, 0.5)',
  },
  
  // Center Controls
  centerControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
  },
  playButton: {
    backgroundColor: 'rgba(2, 169, 255, 0.9)',
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#02A9FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  skipButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  skipText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    position: 'absolute',
    bottom: 8,
  },
  
  // Bottom Bar
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  timeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    minWidth: 48,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  progressContainer: {
    flex: 1,
    marginHorizontal: 12,
    paddingVertical: 8,
  },
  progressBar: {
    height: 24,
    justifyContent: 'center',
    paddingVertical: 10,
  },
  progressTrack: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 2,
    position: 'relative',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#02A9FF',
    borderRadius: 2,
    position: 'absolute',
    top: 0,
    left: 0,
  },
  progressThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    backgroundColor: '#fff',
    borderRadius: 7,
    top: -5,
    marginLeft: -7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  chapterMarker: {
    position: 'absolute',
    width: 3,
    height: 10,
    backgroundColor: 'rgba(255, 215, 0, 0.8)',
    top: -3,
    marginLeft: -1.5,
    borderRadius: 1.5,
  },
  
  // Chapter Menu
  chapterMenuOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  chapterMenuContainer: {
    position: 'absolute',
    backgroundColor: 'rgba(20, 20, 20, 0.95)',
    borderRadius: 12,
    padding: 14,
    width: 200,
    maxHeight: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  chapterMenuTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  chapterMenuScroll: {
    maxHeight: 150,
  },
  chapterMenuItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  chapterMenuItemTitle: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 3,
  },
  chapterMenuItemTime: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 10,
  },
  
  // Settings Modal
  settingsModal: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
  },
  settingsContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    maxWidth: Math.min(width * 0.9, 420),
    maxHeight: height * 0.75,
    width: '90%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  settingsTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  settingsTabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  settingsTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  settingsTabActive: {
    borderBottomColor: '#02A9FF',
  },
  settingsTabText: {
    color: '#888',
    fontSize: 12,
    fontWeight: '500',
  },
  settingsTabTextActive: {
    color: '#02A9FF',
  },
  settingsBody: {
    maxHeight: height * 0.5,
  },
  settingsScrollContent: {
    padding: 16,
    paddingBottom: 24,
  },
  settingsSection: {
    marginBottom: 20,
  },
  sectionTitle: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  settingLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  toggleButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    minWidth: 60,
    alignItems: 'center',
  },
  toggleButtonActive: {
    backgroundColor: '#02A9FF',
  },
  toggleButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  optionButtonWide: {
    flex: 1,
    minWidth: '45%',
  },
  optionButtonSelected: {
    backgroundColor: 'rgba(2, 169, 255, 0.2)',
    borderColor: '#02A9FF',
  },
  optionText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  optionTextSelected: {
    color: '#02A9FF',
    fontWeight: '600',
  },
  sliderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  slider: {
    flex: 1,
    height: 40,
  },
  sliderLabel: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 11,
    fontWeight: '500',
    minWidth: 28,
    textAlign: 'center',
  },
});

