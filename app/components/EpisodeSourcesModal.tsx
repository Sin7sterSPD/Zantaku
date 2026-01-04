import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions, TouchableWithoutFeedback, FlatList, ActivityIndicator } from 'react-native';
import { BlurView } from 'expo-blur';
import axios from 'axios';
import Reanimated, { Easing } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';
import { animeZoneProvider } from '../../api/animezone';
import { xlProvider } from '../../api/proxy/providers/anime/xl';
import { 
  fetchRawByAnilistId, 
  fetchFileDetailsByAccessId, 
  getCachedRaw, 
  setCachedRaw,
  getCachedFileDetails,
  setCachedFileDetails,
  ZenRawItem,
  ZenFileData 
} from '../../services/zencloud';

// Constants
const COLOR = {
  primary: '#02A9FF',
  warning: '#FFB020',
  danger: '#FF5E5E',
  backdrop: 'rgba(0,0,0,0.85)'
};

const PROVIDER_COLORS = {
  xl: '#9C27B0',
  zencloud: '#FF9800',
  animepahe: '#4CAF50',
  animezone: '#2196F3',
};

// Types
type Provider = 'animepahe' | 'animezone' | 'xl' | 'zencloud';
type AudioType = 'sub' | 'dub';

interface Source {
  quality: string;
  url: string;
  type: AudioType;
  headers: Record<string, string>;
  isM3U8?: boolean;
  name?: string;
  provider?: Provider;
}

interface Subtitle {
  url: string;
  lang: string;
}

interface VideoTimings {
  intro?: { start: number; end: number; };
  outro?: { start: number; end: number; };
}

interface EpisodeSourcesModalProps {
  visible: boolean;
  episodeId: string;
  onClose: () => void;
  onSelectSource: (
    url: string,
    headers: any,
    episodeId: string,
    episodeNumber: string,
    subtitles?: Subtitle[],
    timings?: VideoTimings,
    anilistId?: string,
    dataKey?: string,
    provider?: string,
    audioType?: AudioType
  ) => void;
  preferredType?: AudioType;
  animeTitle?: string;
  malId?: string;
  anilistId?: string;
  currentProvider?: string;
  skipTypeSelection?: boolean;
  episodeNumber?: number;
}

// Hook to load source settings
const useSourceSettings = () => {
  const [sourceSettings, setSourceSettings] = useState({
    preferredType: 'sub' as AudioType,
    autoSelectSource: true,
  });

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const sourceData = await AsyncStorage.getItem('sourceSettings');
        if (sourceData) {
          const parsedSettings = JSON.parse(sourceData);
          setSourceSettings(prev => ({ ...prev, ...parsedSettings }));
        }
      } catch (error) {
        // Silent fail
      }
    };
    loadSettings();
  }, []);

  return sourceSettings;
};

// Source Row Component
const SourceRow = React.memo(({ selected, item, onPress }: { 
  selected: boolean; 
  item: Source & { note?: string }; 
  onPress: () => void;
}) => {
  const providerColor = item.provider ? PROVIDER_COLORS[item.provider as keyof typeof PROVIDER_COLORS] || COLOR.primary : COLOR.primary;
  const providerName = item.provider === 'xl' ? 'XL' : 
                       item.provider === 'zencloud' ? 'Zencloud' : 
                       item.provider === 'animepahe' ? 'AnimePahe' : 
                       item.provider === 'animezone' ? 'AnimeZone' : '';
  
  return (
    <TouchableOpacity onPress={onPress} style={styles.sourceRow}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.sourceLabel}>{item.quality}</Text>
          {providerName && (
            <View style={[styles.providerTag, { borderColor: providerColor, backgroundColor: `${providerColor}20` }]}>
              <Text style={[styles.providerTagText, { color: providerColor }]}>
                {providerName}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.sourceTags}>
          <View style={[styles.tag, { borderColor: 'rgba(255,255,255,0.2)'}]}>
            <Text style={styles.tagText}>{item.isM3U8 ? 'HLS' : 'MP4'}</Text>
          </View>
          {item.type && (
            <View style={[styles.tag, { 
              borderColor: item.type === 'dub' ? '#FF9800' : '#4CAF50', 
              backgroundColor: item.type === 'dub' ? '#FF980020' : '#4CAF5020'
            }]}>
              <Text style={[styles.tagText, { 
                color: item.type === 'dub' ? '#FF9800' : '#4CAF50'
              }]}>
                {item.type.toUpperCase()}
              </Text>
            </View>
          )}
          {item.note && (
            <View style={[styles.tag, { borderColor: COLOR.primary }]}>
              <Text style={[styles.tagText, { color: COLOR.primary }]}>{item.note}</Text>
            </View>
          )}
        </View>
      </View>
      <FontAwesome5 name="play" color={providerColor} size={16} />
    </TouchableOpacity>
  );
});

SourceRow.displayName = 'SourceRow';

// Main Component
export default function EpisodeSourcesModal({ 
  visible, 
  episodeId, 
  onClose, 
  onSelectSource,
  preferredType = 'sub',
  animeTitle,
  malId,
  anilistId,
  currentProvider,
  skipTypeSelection = false,
  episodeNumber
}: EpisodeSourcesModalProps) {
  const sourceSettings = useSourceSettings();
  
  // State
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [type, setType] = useState<AudioType>(preferredType || 'sub');
  const [error, setError] = useState<string | null>(null);
  const [fadeAnim] = useState(new Animated.Value(0));
  const [scaleAnim] = useState(new Animated.Value(0.95));
  const [timings, setTimings] = useState<VideoTimings | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const subtitlesRef = useRef<Subtitle[]>([]);
  const [showQualitySelection, setShowQualitySelection] = useState(false);
  const [availableQualities, setAvailableQualities] = useState<{
    quality: string;
    url: string;
    isDefault: boolean;
    headers: Record<string, string>;
    audioType?: AudioType;
  }[]>([]);
  
  // Zencloud state
  const [zencloudLoading, setZencloudLoading] = useState(false);
  const [zencloudFile, setZencloudFile] = useState<ZenFileData | null>(null);
  const [zencloudError, setZencloudError] = useState<string | null>(null);
  
  const episodeNumberStr = episodeNumber?.toString() || '';

  // Animation
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        })
      ]).start();

      setLoading(true);
      setError(null);
      const initialType = preferredType || sourceSettings.preferredType || 'sub';
      setType(initialType);
      fetchSources(episodeId, initialType);
      
      if (anilistId && episodeNumber) {
        fetchZencloudData();
      }
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.95);
      setZencloudFile(null);
      setZencloudError(null);
    }
  }, [visible, skipTypeSelection, currentProvider, anilistId, episodeNumber]);

  // Format source with headers
  const formatSourceWithHeaders = (source: any, apiHeaders: any, sourceType: AudioType, provider?: Provider): Source => {
    let headers: Record<string, string> = {};
    const urlStr: string = source.url || '';
    const isKurojiProxied = typeof urlStr === 'string' && urlStr.includes('kuroji.1ani.me/api/proxy?url=');
    
    if (isKurojiProxied) {
      headers = {};
    } else if (provider === 'animepahe') {
      headers = {
        ...apiHeaders,
        Referer: 'https://animepahe.com/',
        Origin: 'https://animepahe.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36'
      };
    } else if (provider === 'animezone') {
      headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36'
      };
    } else if (provider === 'xl') {
      headers = {
        'Referer': 'https://zuko.to/',
        'Origin': 'https://zuko.to',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        ...(apiHeaders || {})
      };
    } else {
      headers = isKurojiProxied ? {} : (apiHeaders || {});
    }
    
    let displayQuality = source.quality || 'default';
    if (provider === 'animezone' && source.name) {
      const nameMatch = source.name.match(/^([^(]+\([^)]+\))/);
      if (nameMatch) {
        displayQuality = nameMatch[1].trim();
      } else {
        displayQuality = source.name;
      }
    }
    
    return {
      url: source.url,
      quality: displayQuality,
      type: source.type || sourceType,
      headers: headers,
      isM3U8: source.url.includes('.m3u8') || source.isM3U8,
      provider: provider,
    };
  };

  // Fetch AniSkip timings
  const fetchAniSkipTimings = async (malIdValue?: string, episodeNum?: number): Promise<VideoTimings | null> => {
    try {
      if (!malIdValue || !episodeNum || Number.isNaN(episodeNum)) {
        return null;
      }

      const url = `https://api.aniskip.com/v2/skip-times/${encodeURIComponent(String(malIdValue).trim())}/${encodeURIComponent(String(episodeNum))}`;
      const qs = new URLSearchParams();
      ['op', 'ed', 'mixed-op', 'mixed-ed'].forEach((t) => qs.append('types', t));
      qs.append('episodeLength', '0');
      
      const res = await axios.get(url, {
        params: qs,
        paramsSerializer: {
          serialize: (p: any) => (p instanceof URLSearchParams ? p.toString() : new URLSearchParams(p).toString()),
        },
        headers: { accept: 'application/json' },
      });

      const data = res?.data;
      if (!data?.found || !Array.isArray(data?.results)) {
        return null;
      }

      const opItems = data.results.filter((r: any) => ['op', 'mixed-op'].includes(r?.skipType));
      const edItems = data.results.filter((r: any) => ['ed', 'mixed-ed'].includes(r?.skipType));

      const pickBestOp = (items: any[]) => {
        if (!items || items.length === 0) return undefined;
        const scored = items
          .filter((r) => r?.interval && typeof r.interval.startTime === 'number' && typeof r.interval.endTime === 'number')
          .map((r) => {
            const len = Number(r.episodeLength || 0);
            const start = Number(r.interval.startTime);
            const typicalCap = len > 0 ? Math.min(220, len * 0.6) : 220;
            const plausibility = start <= typicalCap ? 1 : 0;
            const width = Math.max(1, r.interval.endTime - start);
            const confidence = Number(r.confidence || 0);
            const score = plausibility * 1000 + (220 - Math.min(220, start)) + confidence - Math.min(60, width);
            return { r, score };
          })
          .sort((a, b) => b.score - a.score);
        return scored.length ? scored[0].r : items[0];
      };

      const pickBestEd = (items: any[]) => {
        if (!items || items.length === 0) return undefined;
        const scored = items
          .filter((r) => r?.interval && typeof r.interval.startTime === 'number' && typeof r.interval.endTime === 'number')
          .map((r) => {
            const len = Number(r.episodeLength || 0);
            const start = Number(r.interval.startTime);
            const threshold = len > 0 ? len * 0.4 : 0;
            const plausibility = start >= threshold ? 1 : 0;
            const confidence = Number(r.confidence || 0);
            const score = plausibility * 1000 + start + confidence;
            return { r, score };
          })
          .sort((a, b) => b.score - a.score);
        return scored.length ? scored[0].r : items[0];
      };

      const bestOp = pickBestOp(opItems);
      const bestEd = pickBestEd(edItems);

      const timings: VideoTimings = {};
      if (bestOp) {
        timings.intro = {
          start: Number(bestOp.interval.startTime),
          end: Number(bestOp.interval.endTime),
        };
      }
      if (bestEd) {
        timings.outro = {
          start: Number(bestEd.interval.startTime),
          end: Number(bestEd.interval.endTime),
        };
      }

      return (timings.intro || timings.outro) ? timings : null;
    } catch (err) {
      return null;
    }
  };

  // Fetch sources
  const fetchSources = async (episodeId: string, type: AudioType) => {
    try {
      setError(null);
      setLoading(true);

      let episodeNum = episodeNumber;
      if (!episodeNum && episodeId) {
        if (episodeId.includes('/')) {
          const parts = episodeId.split('/')[1];
          if (parts && parts.startsWith('episode-')) {
            episodeNum = parseInt(parts.replace('episode-', ''));
          }
        } else if (episodeId.includes('?ep=')) {
          episodeNum = parseInt(episodeId.split('?ep=')[1]);
        }
      }
      
      if (!episodeNum || isNaN(episodeNum)) {
        throw new Error('Invalid episode number');
      }
      
      const provider = currentProvider as Provider;
      
      if (provider === 'xl') {
        if (!anilistId) {
          throw new Error('AniList ID required for XL provider');
        }
        
        const watchData = await xlProvider.getWatchData(String(anilistId), type === 'dub', episodeNum);
        
        if (watchData && Array.isArray(watchData.sources) && watchData.sources.length > 0) {
          const formattedSources = watchData.sources.map((source: any) => 
            formatSourceWithHeaders(source, watchData.headers || {}, type, 'xl')
          );
          
          const subs = Array.isArray(watchData.subtitles) ? watchData.subtitles : [];
          setSources(formattedSources);
          setSubtitles(subs);
          subtitlesRef.current = subs;
          
          const aniTimings = await fetchAniSkipTimings(malId, episodeNum);
          setTimings(aniTimings || null);
          
          const qualityOptions = formattedSources.map((source: Source, index: number) => ({
            quality: source.quality || `Source ${index + 1}`,
            url: source.url,
            headers: source.headers,
            isDefault: index === 0,
            audioType: source.type || type
          }));
          
          setAvailableQualities(qualityOptions);
          setShowQualitySelection(true);
          setLoading(false);
          return;
        }
        
      } else if (provider === 'animezone') {
        if (!animeTitle) {
          throw new Error('Anime title required for AnimeZone provider');
        }
        
        const results = await animeZoneProvider.smartSearch(animeTitle, anilistId);
        const azId = results?.[0]?.id;
        
        if (!azId) {
          throw new Error('Could not find anime on AnimeZone');
        }
        
        const watchData = await animeZoneProvider.getWatchData(azId, episodeNum);
        
        if (watchData && Array.isArray(watchData.sources) && watchData.sources.length > 0) {
          const typeFilteredSources = watchData.sources.filter((source: any) => source.type === type);
          const sourcesToUse = typeFilteredSources.length > 0 ? typeFilteredSources : watchData.sources;
          
          const formattedSources = sourcesToUse.map((source: any) => 
            formatSourceWithHeaders(source, watchData.headers || {}, type, 'animezone')
          );
          
          const subs = Array.isArray(watchData.subtitles) ? watchData.subtitles : [];
          setSources(formattedSources);
          setSubtitles(subs);
          subtitlesRef.current = subs;
          
          const aniTimings = await fetchAniSkipTimings(malId, episodeNum);
          setTimings(aniTimings || null);
          
          const qualityOptions = formattedSources.map((source: Source, index: number) => ({
            quality: source.quality || `Source ${index + 1}`,
            url: source.url,
            headers: source.headers,
            isDefault: index === 0,
            audioType: source.type || type
          }));
          
          setAvailableQualities(qualityOptions);
          setShowQualitySelection(true);
          setLoading(false);
          return;
        }
      }
      
      throw new Error(`No ${type.toUpperCase()} sources found from ${provider || 'provider'}`);
      
    } catch (error: any) {
      setError(error instanceof Error ? error.message : 'Failed to fetch sources');
    } finally {
      setLoading(false);
    }
  };

  // Handle source select
  const handleSourceSelect = (source: Source) => {
    let currentSubtitles = [...subtitles];
    if (currentSubtitles.length === 0 && subtitlesRef.current.length > 0) {
      currentSubtitles = [...subtitlesRef.current];
    }
    const currentTimings = timings;

    const dataKey = `source_${Date.now().toString()}`;
    
    AsyncStorage.setItem(dataKey, JSON.stringify({
      source: source.url,
      headers: source.headers,
      episodeId: episodeId,
      episodeNumber: episodeNumberStr ? parseInt(episodeNumberStr) : undefined,
      subtitles: (currentSubtitles || []).map(sub => ({
        ...sub,
        url: sub.url?.replace('cdn.zencloud.cc', 'zantaku.zencloud.cc') || sub.url
      })),
      timings: currentTimings || null,
      anilistId: anilistId || '',
      animeTitle: animeTitle || '',
      provider: currentProvider || 'animepahe',
      audioType: source.type,
      timestamp: Date.now()
    })).catch(console.error);
    
    onSelectSource(
      source.url,
      source.headers,
      episodeId,
      episodeNumberStr,
      currentSubtitles,
      currentTimings,
      anilistId,
      dataKey,
      currentProvider || 'animepahe',
      source.type
    );
  };

  // Handle direct source select (for Zencloud)
  const handleDirectSourceSelect = (
    source: Source,
    directSubtitles: Subtitle[],
    directTimings?: VideoTimings,
    anilistIdParam?: string,
    selectedProvider?: string
  ) => {
    const dataKey = `source_${Date.now().toString()}`;
    
    const payload = {
      source: source.url,
      headers: source.headers,
      episodeId: episodeId,
      episodeNumber: episodeNumberStr ? parseInt(episodeNumberStr) : undefined,
      subtitles: (directSubtitles || []).map(sub => ({
        ...sub,
        url: sub.url?.replace('cdn.zencloud.cc', 'zantaku.zencloud.cc') || sub.url
      })),
      timings: directTimings || null,
      anilistId: anilistIdParam || '',
      animeTitle: animeTitle || '',
      provider: selectedProvider || currentProvider || 'zencloud',
      audioType: source.type,
      timestamp: Date.now(),
      zencloudData: zencloudFile ? {
        ...zencloudFile,
        file_code: zencloudFile?.file_code || '',
        m3u8_url: zencloudFile?.m3u8_url?.replace('cdn.zencloud.cc', 'zantaku.zencloud.cc') || '',
        original_filename: zencloudFile?.original_filename || 'Unknown',
        subtitles: zencloudFile?.subtitles?.map(sub => ({
          ...sub,
          url: sub.url?.replace('cdn.zencloud.cc', 'zantaku.zencloud.cc') || sub.url
        })) || [],
        chapters: zencloudFile?.chapters || [],
        fonts: zencloudFile?.fonts?.map(font => ({
          ...font,
          url: font.url?.replace('cdn.zencloud.cc', 'zantaku.zencloud.cc') || font.url
        })) || [],
        token: zencloudFile?.token || '',
        token_expires: zencloudFile?.token_expires || '',
        client_ip: zencloudFile?.client_ip || '',
        token_ip_bound: zencloudFile?.token_ip_bound || false
      } : null
    };
    
    AsyncStorage.setItem(dataKey, JSON.stringify(payload)).catch(console.error);
    
    onSelectSource(
      source.url,
      source.headers,
      episodeId,
      episodeNumberStr,
      directSubtitles,
      directTimings,
      anilistIdParam,
      dataKey,
      selectedProvider || currentProvider || 'zencloud',
      source.type
    );
  };

  // Fetch Zencloud data
  const fetchZencloudData = useCallback(async () => {
    if (!anilistId || !episodeNumber) return;
    
    setZencloudLoading(true);
    setZencloudError(null);
    setZencloudFile(null);
    
    try {
      let rawData = await getCachedRaw(parseInt(anilistId));
      
      if (!rawData) {
        rawData = await fetchRawByAnilistId(parseInt(anilistId));
        await setCachedRaw(parseInt(anilistId), rawData);
      }
      
      const targetEpisode = rawData.find(item => item.episode === episodeNumber);
      if (!targetEpisode) {
        throw new Error(`Episode ${episodeNumber} not available on Zencloud`);
      }
      
      let fileData = await getCachedFileDetails(targetEpisode.access_id);
      
      if (!fileData) {
        fileData = await fetchFileDetailsByAccessId(targetEpisode.access_id);
        await setCachedFileDetails(targetEpisode.access_id, fileData);
      }
      
      setZencloudFile(fileData);
      
    } catch (error: any) {
      setZencloudError(error?.message || 'Failed to load Zencloud data');
    } finally {
      setZencloudLoading(false);
    }
  }, [anilistId, episodeNumber]);

  // Zencloud Section
  const ZencloudSection = () => {
    const handleZencloudPlay = () => {
      if (!zencloudFile) return;
      
      const zencloudSource: Source = {
        url: zencloudFile.m3u8_url,
        quality: 'Zencloud HLS',
        type: type,
        headers: {},
        isM3U8: true,
        provider: 'zencloud'
      };
      
      const zencloudSubtitles = zencloudFile.subtitles?.map(sub => ({
        url: sub.url,
        lang: sub.language_name || sub.language
      })) || [];
      
      let zencloudTimings: VideoTimings | undefined;
      if (zencloudFile.chapters && zencloudFile.chapters.length > 0) {
        const introChapter = zencloudFile.chapters.find(c => 
          c.title.toLowerCase().includes('intro') || 
          c.title.toLowerCase().includes('opening') ||
          c.title.toLowerCase().includes('op')
        );
        const outroChapter = zencloudFile.chapters.find(c => 
          c.title.toLowerCase().includes('outro') || 
          c.title.toLowerCase().includes('ending') ||
          c.title.toLowerCase().includes('ed')
        );
        
        if (introChapter || outroChapter) {
          zencloudTimings = {};
          if (introChapter) {
            zencloudTimings.intro = {
              start: introChapter.start_time,
              end: introChapter.end_time
            };
          }
          if (outroChapter) {
            zencloudTimings.outro = {
              start: outroChapter.start_time,
              end: outroChapter.end_time
            };
          }
        }
      }

      handleDirectSourceSelect(
        zencloudSource,
        zencloudSubtitles,
        zencloudTimings,
        anilistId,
        'zencloud'
      );
    };
    
    if (!zencloudFile && !zencloudLoading && !zencloudError) {
      return null;
    }

    return (
      <View style={{ marginTop: currentProvider === 'xl' ? 0 : 16 }}>
        {zencloudLoading && (
          <View style={styles.zencloudLoading}>
            <ActivityIndicator size="small" color={PROVIDER_COLORS.zencloud} />
            <Text style={styles.zencloudLoadingText}>Loading Zencloud data...</Text>
          </View>
        )}
        
        {zencloudError && (
          <View style={styles.zencloudError}>
            <Text style={styles.zencloudErrorText}>⚠️ {zencloudError}</Text>
            <TouchableOpacity 
              style={styles.zencloudRetryButton}
              onPress={fetchZencloudData}
            >
              <Text style={styles.zencloudRetryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
        
        {zencloudFile && (
          <TouchableOpacity 
            style={styles.zencloudPlayButton}
            onPress={handleZencloudPlay}
          >
            <FontAwesome5 name="play" size={14} color="#000" style={{ marginRight: 8 }} />
            <Text style={styles.zencloudPlayText}>Play Zencloud</Text>
            <View style={styles.zencloudQualityBadge}>
              <Text style={styles.zencloudQualityText}>HLS</Text>
            </View>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // Quality Selection View
  const QualitySelectionView = () => {
    const data = availableQualities.map((q, idx) => ({
      ...q,
      note: idx === 0 ? 'Recommended' : undefined,
      provider: currentProvider as Provider,
    }));

    return (
      <View style={{ width: '100%' }}>
        <Text style={[styles.bodyTitle, { marginBottom: 12 }]}>
          {availableQualities.length} {availableQualities.length > 1 ? 'sources' : 'source'} available
        </Text>
        
        <FlatList
          data={data}
          keyExtractor={(item, index) => `${item.quality}-${index}`}
          renderItem={({ item, index }) => (
            <SourceRow
              selected={index === 0}
              item={item}
              onPress={() => {
                handleSourceSelect({ 
                  url: item.url, 
                  quality: item.quality, 
                  type: type, 
                  headers: item.headers, 
                  isM3U8: item.url.includes('.m3u8'),
                  provider: item.provider
                });
              }}
            />
          )}
          style={{ maxHeight: 320, marginBottom: 12 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
        
        <View style={styles.footerRow}>
          <TouchableOpacity 
            style={[styles.secondaryBtn, { flex: 1 }]} 
            onPress={() => fetchSources(episodeId, type)}
          >
            <Text style={styles.secondaryBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>
        
        <Text style={styles.smallHint}>HLS adapts quality automatically</Text>
      </View>
    );
  };

  const hasResults = availableQualities && availableQualities.length > 0;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <Animated.View style={[styles.container, { opacity: fadeAnim }]} />
      </TouchableWithoutFeedback>
      <BlurView intensity={10} tint="dark" style={styles.blurContainer}>
        <Animated.View style={[styles.content, { transform: [{ scale: scaleAnim }] }]}> 
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={onClose} style={styles.headerCloseLeft}>
              <FontAwesome5 name="times" size={18} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.titleText}>Episode {episodeNumberStr}</Text>
            <View style={{ width: 32 }} />
          </View>

          <View style={{ width: '100%' }}>
            {loading && !showQualitySelection && (
              <View style={styles.loadingSimple}>
                <Text style={styles.bodyTitle}>Fetching sources…</Text>
                <ActivityIndicator size="small" color={COLOR.primary} style={{ marginTop: 8 }} />
              </View>
            )}

            {!loading && error && !showQualitySelection && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTextPlain}>{error}</Text>
              </View>
            )}

            {currentProvider === 'xl' && showQualitySelection && availableQualities.length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <View style={{ width: 3, height: 16, backgroundColor: PROVIDER_COLORS.xl, borderRadius: 1.5 }} />
                  <Text style={[styles.bodyTitle, { color: PROVIDER_COLORS.xl, fontSize: 15, marginBottom: 0 }]}>
                    XL (Zuko)
                  </Text>
                </View>
                <View style={[styles.warningBox, { marginBottom: 12 }]}>
                  <Text style={styles.warningText}>⚠️ Some anime may be limited and quality varies</Text>
                </View>
                <QualitySelectionView />
              </View>
            )}
            
            {currentProvider !== 'xl' && showQualitySelection && availableQualities.length > 0 && (
              <View style={{ marginBottom: 20 }}>
                {currentProvider === 'animezone' && (
                  <View style={[styles.warningBox, { marginBottom: 12 }]}>
                    <Text style={styles.warningText}>⚠️ New API - Some anime may not work properly</Text>
                  </View>
                )}
                <QualitySelectionView />
              </View>
            )}
            
            {currentProvider === 'xl' && zencloudFile && (
              <View style={{ marginTop: 20, paddingTop: 20, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <View style={{ width: 3, height: 16, backgroundColor: PROVIDER_COLORS.zencloud, borderRadius: 1.5 }} />
                  <Text style={[styles.bodyTitle, { color: PROVIDER_COLORS.zencloud, fontSize: 15, marginBottom: 0 }]}>
                    Alternative: Zencloud
                  </Text>
                </View>
                <ZencloudSection />
              </View>
            )}

            {currentProvider !== 'xl' && <ZencloudSection />}
          </View>
        </Animated.View>
      </BlurView>
    </Modal>
  );
}

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLOR.backdrop,
  },
  blurContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    width: Math.min(width * 0.92, 420),
    backgroundColor: '#151515',
    borderRadius: 12,
    padding: 16,
    alignItems: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerCloseLeft: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)' },
  titleText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  bodyTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', marginBottom: 8 },
  loadingSimple: { paddingVertical: 12 },
  errorBox: { paddingVertical: 12 },
  errorTextPlain: { color: COLOR.danger, fontSize: 13, marginBottom: 6 },
  warningBox: { 
    backgroundColor: 'rgba(255, 176, 32, 0.08)', 
    borderWidth: 1, 
    borderColor: 'rgba(255, 176, 32, 0.25)', 
    borderRadius: 8, 
    padding: 10, 
    marginBottom: 12 
  },
  warningText: { 
    color: COLOR.warning, 
    fontSize: 11, 
    fontWeight: '500', 
    textAlign: 'left',
    lineHeight: 16
  },
  sourceRow: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingVertical: 12, 
    paddingHorizontal: 4,
    gap: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  sourceLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  sourceTags: { flexDirection: 'row', gap: 6, marginTop: 4 },
  tag: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  tagText: { color: '#FFFFFF', fontSize: 11 },
  providerTag: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  providerTagText: { fontSize: 11, fontWeight: '600' },
  footerRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  secondaryBtn: { flex: 1, borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  secondaryBtnText: { color: '#fff', fontWeight: '700' },
  smallHint: { color: 'rgba(255,255,255,0.7)', marginTop: 8, fontSize: 12 },
  zencloudLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  zencloudLoadingText: {
    color: '#FFD700',
    fontSize: 13,
    fontWeight: '500',
  },
  zencloudError: {
    backgroundColor: 'rgba(255, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 68, 0.3)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  zencloudErrorText: {
    color: '#FF4444',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  zencloudRetryButton: {
    backgroundColor: 'rgba(255, 68, 68, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  zencloudRetryText: {
    color: '#FF4444',
    fontSize: 12,
    fontWeight: '600',
  },
  zencloudPlayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFD700',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  zencloudPlayText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  zencloudQualityBadge: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  zencloudQualityText: {
    color: '#000',
    fontSize: 11,
    fontWeight: '600',
  },
});
