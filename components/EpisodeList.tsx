import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Platform, useWindowDimensions, ScrollView, DeviceEventEmitter } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import EpisodeSourcesModal from '../app/components/EpisodeSourcesModal';
import CorrectAnimeSearchModal from './CorrectAnimeSearchModal';
import { requestNotificationPermissions, toggleNotifications, isNotificationEnabled } from '../utils/notifications';
import axios from 'axios';
import { STORAGE_KEY } from '../constants/auth';
import * as SecureStore from 'expo-secure-store';
import { FlashList } from '@shopify/flash-list';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { animePaheProvider } from '../api/proxy/providers/anime/animepahe';
import { xlProvider } from '../api/proxy/providers/anime/xl';
import { detectDeviceCapabilities, PERFORMANCE_CONFIG, MemoryManager } from '../utils/performanceOptimization';
import OptimizedImage from './OptimizedImage';
import { fetchRelatedSeasons } from '../api/anilist/queries';
import useSeasons from '../hooks/useSeasons';
import { useSeasonSelection } from '../contexts/SeasonStore';
import { fetchJikanEpisodes, fetchJikanAnimeData, JikanEpisode } from '../utils/jikanApi';

// Constants
const ANILIST_GRAPHQL_ENDPOINT = 'https://graphql.anilist.co';
const PLACEHOLDER_BLUR_HASH = PERFORMANCE_CONFIG.BLUR_HASH_PLACEHOLDER;
const deviceCapabilities = detectDeviceCapabilities();

// Types
type Provider = 'animepahe' | 'animezone' | 'xl';
type AudioType = 'sub' | 'dub';

interface Episode {
  id: string;
  number: number;
  title?: string;
  image?: string;
  progress?: number;
  isFiller?: boolean;
  isRecap?: boolean;
  aired?: string;
  anilistId?: string;
  description?: string;
  duration?: number;
  provider?: string;
  isSubbed?: boolean;
  isDubbed?: boolean;
  providerIds?: {
    animepahe?: string;
    xl?: string;
  };
}

interface EpisodeProgress {
  timestamp: number;
  duration: number;
  percentage: number;
}

interface EpisodeListProps {
  episodes: Episode[];
  loading: boolean;
  animeTitle: string;
  anilistId?: string;
  malId?: string;
  coverImage?: string;
  mangaTitle?: string;
}

interface Season {
  id: string;
  title: {
    userPreferred: string;
    english?: string;
    romaji?: string;
    native?: string;
  };
  format: string;
  status: string;
  startDate: {
    year?: number;
    month?: number;
    day?: number;
  };
  episodes?: number;
  coverImage?: {
    large: string;
    color?: string;
  };
  averageScore?: number;
  season?: string;
  seasonYear?: number;
}

// Hooks
const useSourceSettings = () => {
  const [sourceSettings, setSourceSettings] = useState({
    preferredType: 'sub' as AudioType,
    defaultProvider: 'animepahe' as Provider,
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
        console.error('Failed to load source settings:', error);
      }
    };

    loadSettings();
    const sub = DeviceEventEmitter.addListener('sourceSettingsChanged', loadSettings);
    return () => sub.remove();
  }, []);

  return sourceSettings;
};

// Helper Functions
const normalizeTitleForMatch = (title?: string) =>
  (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const safeFormatDate = (dateString?: string, options?: Intl.DateTimeFormatOptions): string | null => {
  try {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, options);
  } catch (error) {
    return null;
  }
};

// Episode Card Components
const EpisodeCard = memo<{
  episode: Episode;
  onPress: (episode: Episode) => void;
  currentProgress: number;
  currentTheme: any;
  isDarkMode: boolean;
  coverImage?: string;
  index: number;
  isVisible: boolean;
  preferredAudioType: AudioType;
  onAudioError: (episode: Episode, requestedType: AudioType) => void;
  episodeProgress?: EpisodeProgress;
  isGrid: boolean;
}>(({ episode, onPress, currentProgress, currentTheme, isDarkMode, coverImage, index, isVisible, preferredAudioType, onAudioError, episodeProgress, isGrid }) => {
  const isWatched = useMemo(() => currentProgress >= (episode.number ?? 0), [currentProgress, episode.number]);
  const safeEpisodeNumber = useMemo(() => String(episode?.number ?? '??'), [episode.number]);
  const safeEpisodeTitle = useMemo(() => episode?.title || `Episode ${safeEpisodeNumber}`, [episode.title, safeEpisodeNumber]);
  const formattedDate = useMemo(() => safeFormatDate(episode?.aired, { month: 'short', day: 'numeric' }), [episode.aired]);

  const audioAvailable = useMemo(() => {
    if (preferredAudioType === 'sub') {
      return episode.isSubbed === true;
    } else {
      return episode.isDubbed === true;
    }
  }, [episode.isSubbed, episode.isDubbed, preferredAudioType]);

  const handlePress = useCallback(() => {
    if (!audioAvailable) {
      onAudioError(episode, preferredAudioType);
      return;
    }
    onPress(episode);
  }, [onPress, episode, audioAvailable, preferredAudioType, onAudioError]);

  const cardStyle = useMemo(() => [
    isGrid ? styles.gridCard : styles.listCard,
    { backgroundColor: isDarkMode ? 'rgba(28, 28, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)' },
    isWatched && (isGrid ? styles.watchedGridCard : styles.watchedListCard),
    !audioAvailable && styles.unavailableCard
  ], [isDarkMode, isWatched, audioAvailable, isGrid]);

  if (isGrid) {
    return (
      <TouchableOpacity style={cardStyle} onPress={handlePress} activeOpacity={0.8}>
        <View style={styles.gridThumbnailContainer}>
          <OptimizedImage
            uri={episode.image || coverImage || ''}
            width={160}
            height={90}
            style={[styles.gridThumbnail, isWatched && styles.watchedThumbnail, !audioAvailable && styles.unavailableThumbnail]}
            placeholder={PLACEHOLDER_BLUR_HASH}
            resizeMode="cover"
            isVisible={isVisible}
            priority={index < 6 ? 'high' : 'normal'}
            reduceMemoryUsage={deviceCapabilities.isLowEndDevice}
            index={index}
          />
          <View style={styles.episodeNumberBadge}>
            <Text style={styles.episodeNumberText}>EP {safeEpisodeNumber}</Text>
          </View>
          {isWatched && (
            <>
              <View style={styles.watchedBadge}>
                <FontAwesome5 name="check" size={10} color="#FFFFFF" />
              </View>
              <View pointerEvents="none" style={styles.watchedOverlay} />
            </>
          )}
          {!audioAvailable && (
            <View style={styles.unavailableBadge}>
              <FontAwesome5 name="exclamation-triangle" size={12} color="#FFFFFF" />
            </View>
          )}
        </View>
        <View style={styles.gridContent}>
          <Text style={[styles.gridTitle, { color: currentTheme.colors.text }, !audioAvailable && styles.unavailableText]} numberOfLines={2}>
            Ep {safeEpisodeNumber}: {safeEpisodeTitle}
          </Text>
          <View style={styles.metaRow}>
            <View style={styles.audioPills}>
              {episode.isSubbed && (
                <View style={[styles.audioPill, styles.subPill, preferredAudioType === 'sub' && styles.preferredPill]}>
                  <Text style={styles.pillText}>🈸 SUB</Text>
                </View>
              )}
              {episode.isDubbed && (
                <View style={[styles.audioPill, styles.dubPill, preferredAudioType === 'dub' && styles.preferredPill]}>
                  <Text style={styles.pillText}>🎧 DUB</Text>
                </View>
              )}
              {episode.isFiller && (
                <View style={[styles.audioPill, styles.fillerPill]}>
                  <FontAwesome5 name="star" size={8} color="#FFFFFF" style={{ marginRight: 4 }} />
                  <Text style={styles.pillText}>Filler</Text>
                </View>
              )}
            </View>
            {formattedDate && (
              <Text style={[styles.dateText, { color: currentTheme.colors.textSecondary }]}>
                {formattedDate}
              </Text>
            )}
          </View>
          <TouchableOpacity 
            style={[styles.watchButton, isWatched && styles.rewatchButton, !audioAvailable && styles.unavailableButton]} 
            onPress={handlePress}
          >
            <FontAwesome5 
              name={!audioAvailable ? "exclamation-triangle" : isWatched ? "redo" : "play"} 
              size={12} 
              color="#FFFFFF" 
              style={{ marginRight: 6 }}
            />
            <Text style={styles.watchButtonText}>
              {!audioAvailable 
                ? "Unavailable" 
                : `${isWatched ? "Rewatch" : "Watch"} (${preferredAudioType === 'sub' ? 'Subbed' : 'Dubbed'})`
              }
            </Text>
          </TouchableOpacity>
          {episodeProgress && episodeProgress.percentage > 0 && !isWatched && (
            <View style={styles.progressContainer}>
              <View style={styles.progressBarBackground}>
                <View style={[styles.progressBarFill, { width: `${episodeProgress.percentage}%` }]} />
              </View>
              <Text style={[styles.progressText, { color: currentTheme.colors.textSecondary }]}>
                {Math.floor(episodeProgress.timestamp / 60)}:{Math.floor(episodeProgress.timestamp % 60).toString().padStart(2, '0')} / {Math.floor(episodeProgress.duration / 60)}:{Math.floor(episodeProgress.duration % 60).toString().padStart(2, '0')}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={cardStyle} onPress={handlePress} activeOpacity={0.8}>
      <View style={styles.listThumbnailContainer}>
        <OptimizedImage
          uri={episode.image || coverImage || ''}
          width={120}
          height={68}
          style={[styles.listThumbnail, isWatched && styles.watchedThumbnail, !audioAvailable && styles.unavailableThumbnail]}
          placeholder={PLACEHOLDER_BLUR_HASH}
          resizeMode="cover"
          isVisible={isVisible}
          priority={index < 6 ? 'high' : 'normal'}
          reduceMemoryUsage={deviceCapabilities.isLowEndDevice}
          index={index}
        />
        {isWatched && (
          <>
            <View style={styles.watchedBadge}>
              <FontAwesome5 name="check" size={10} color="#FFFFFF" />
            </View>
            <View pointerEvents="none" style={styles.watchedOverlay} />
          </>
        )}
        {!audioAvailable && (
          <View style={styles.unavailableBadge}>
            <FontAwesome5 name="exclamation-triangle" size={12} color="#FFFFFF" />
          </View>
        )}
      </View>
      <View style={styles.listContent}>
        <Text style={[styles.listTitle, { color: currentTheme.colors.text }, !audioAvailable && styles.unavailableText]} numberOfLines={2}>
          Ep {safeEpisodeNumber}: {safeEpisodeTitle}
        </Text>
        <View style={styles.metaRow}>
          <View style={styles.audioPills}>
            {episode.isSubbed && (
              <View style={[styles.audioPill, styles.subPill, preferredAudioType === 'sub' && styles.preferredPill]}>
                <Text style={styles.pillText}>🈸 SUB</Text>
              </View>
            )}
            {episode.isDubbed && (
              <View style={[styles.audioPill, styles.dubPill, preferredAudioType === 'dub' && styles.preferredPill]}>
                <Text style={styles.pillText}>🎧 DUB</Text>
              </View>
            )}
            {episode.isFiller && (
              <View style={[styles.audioPill, styles.fillerPill]}>
                <FontAwesome5 name="star" size={8} color="#FFFFFF" style={{ marginRight: 4 }} />
                <Text style={styles.pillText}>Filler</Text>
              </View>
            )}
          </View>
          {formattedDate && (
            <Text style={[styles.dateText, { color: currentTheme.colors.textSecondary }]}>
              Aired: {formattedDate}
            </Text>
          )}
        </View>
        <TouchableOpacity 
          style={[styles.watchButton, isWatched && styles.rewatchButton, !audioAvailable && styles.unavailableButton]} 
          onPress={handlePress}
        >
          <FontAwesome5 
            name={!audioAvailable ? "exclamation-triangle" : isWatched ? "redo" : "play"} 
            size={12} 
            color="#FFFFFF" 
            style={{ marginRight: 6 }}
          />
          <Text style={styles.watchButtonText}>
            {!audioAvailable 
              ? "Unavailable" 
              : `${isWatched ? "Rewatch" : "Watch"} (${preferredAudioType === 'sub' ? 'Subbed' : 'Dubbed'})`
            }
          </Text>
        </TouchableOpacity>
        {episodeProgress && episodeProgress.percentage > 0 && !isWatched && (
          <View style={styles.progressContainer}>
            <View style={styles.progressBarBackground}>
              <View style={[styles.progressBarFill, { width: `${episodeProgress.percentage}%` }]} />
            </View>
            <Text style={[styles.progressText, { color: currentTheme.colors.textSecondary }]}>
              {Math.floor(episodeProgress.timestamp / 60)}:{Math.floor(episodeProgress.timestamp % 60).toString().padStart(2, '0')} / {Math.floor(episodeProgress.duration / 60)}:{Math.floor(episodeProgress.duration % 60).toString().padStart(2, '0')}
            </Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.episode.id === nextProps.episode.id &&
    prevProps.episode.number === nextProps.episode.number &&
    prevProps.currentProgress === nextProps.currentProgress &&
    prevProps.isVisible === nextProps.isVisible &&
    prevProps.index === nextProps.index &&
    prevProps.preferredAudioType === nextProps.preferredAudioType &&
    prevProps.episode.isSubbed === nextProps.episode.isSubbed &&
    prevProps.episode.isDubbed === nextProps.episode.isDubbed &&
    prevProps.isGrid === nextProps.isGrid
  );
});

EpisodeCard.displayName = 'EpisodeCard';

// Main Component
const EpisodeList: React.FC<EpisodeListProps> = ({ episodes, loading, animeTitle, anilistId, malId, coverImage }) => {
  const { currentTheme, isDarkMode } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const sourceSettings = useSourceSettings();
  
  // State
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [isNewestFirst, setIsNewestFirst] = useState(false);
  const [columnCount, setColumnCount] = useState(width > 600 ? 2 : 1);
  const [showCorrectAnimeModal, setShowCorrectAnimeModal] = useState(false);
  const [currentAnimeTitle, setCurrentAnimeTitle] = useState(animeTitle);
  const [preferredAudioType, setPreferredAudioType] = useState<AudioType>(sourceSettings.preferredType);
  const [currentProvider, setCurrentProvider] = useState<Provider>(sourceSettings.defaultProvider);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [episodeRanges, setEpisodeRanges] = useState<Record<string, Episode[]>>({});
  const [activeTab, setActiveTab] = useState('1-12');
  const [episodeProgressMap, setEpisodeProgressMap] = useState<Record<string, EpisodeProgress>>({});
  
  // Provider state
  const [providerEpisodes, setProviderEpisodes] = useState<Episode[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [animePaheAnimeId, setAnimePaheAnimeId] = useState<string | null>(null);
  
  // Jikan metadata
  const [jikanEpisodes, setJikanEpisodes] = useState<JikanEpisode[]>([]);
  const [jikanLoading, setJikanLoading] = useState(false);
  
  // Season state
  const { seasons: aniSeasons } = useSeasons(anilistId);
  const { selected: selectedSeason } = useSeasonSelection();
  const [availableSeasons, setAvailableSeasons] = useState<Season[]>([]);
  const [currentSeason, setCurrentSeason] = useState<Season | null>(null);
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  
  const flashListRef = useRef<any>(null);
  
  // Memory management
  useEffect(() => {
    return () => {
      MemoryManager.clearCache();
    };
  }, []);

  // Load UI settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const stored = await AsyncStorage.getItem('episodeListSettings');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (typeof parsed.defaultColumnCount === 'number') {
            setColumnCount(parsed.defaultColumnCount);
          }
          if (typeof parsed.newestFirst === 'boolean') {
            setIsNewestFirst(parsed.newestFirst);
          }
        }
      } catch (e) {
        // Silent fail
      }
    };
    loadSettings();
    const sub = DeviceEventEmitter.addListener('episodeListSettingsChanged', loadSettings);
    return () => sub.remove();
  }, [width]);

  // Fetch AniList progress
  const fetchAniListProgress = useCallback(async () => {
    if (!anilistId) return;
    try {
      const token = await SecureStore.getItemAsync(STORAGE_KEY.AUTH_TOKEN);
      if (!token) return;
      
      const query = `query ($mediaId: Int) { Media(id: $mediaId) { mediaListEntry { progress } } }`;
      const response = await axios.post(
        ANILIST_GRAPHQL_ENDPOINT,
        { query, variables: { mediaId: parseInt(String(anilistId), 10) } },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      const progressVal: number | undefined = response?.data?.data?.Media?.mediaListEntry?.progress;
      if (typeof progressVal === 'number') {
        setCurrentProgress(progressVal);
      }
    } catch (error) {
      // Silent fail
    }
  }, [anilistId]);

  // Fetch related seasons
  const fetchRelatedSeasonsData = useCallback(async (anilistId: string, animeTitle: string) => {
    const cacheKey = `${anilistId}_${animeTitle}`;
    setSeasonsLoading(true);
    
    try {
      const seasons = await fetchRelatedSeasons(anilistId, animeTitle);
      setAvailableSeasons(seasons);
      
      if (!currentSeason && seasons.length > 0) {
        const normQuery = normalizeTitleForMatch(animeTitle);
        const bestMatch = seasons.find(s => 
          normalizeTitleForMatch(s.title.userPreferred || s.title.romaji || s.title.english) === normQuery
        ) || seasons.find(s => s.id === anilistId) || seasons[0];
        setCurrentSeason(bestMatch);
      }
    } catch (error) {
      setAvailableSeasons([]);
    } finally {
      setSeasonsLoading(false);
    }
  }, [currentSeason]);

  // Sync AniList seasons
  useEffect(() => {
    if (!aniSeasons || aniSeasons.length === 0) return;
    const mapped: Season[] = aniSeasons.map((s: any) => ({
      id: s.id,
      title: { userPreferred: s.title?.userPreferred, english: s.title?.english, romaji: s.title?.romaji, native: s.title?.native },
      format: s.format,
      status: '',
      startDate: { year: s.seasonYear },
      episodes: s.episodes ?? undefined,
      coverImage: undefined,
      averageScore: undefined,
      season: s.season,
      seasonYear: s.seasonYear,
    }));
    setAvailableSeasons(mapped);
    if (!currentSeason && mapped.length > 0) setCurrentSeason(mapped[0]);
  }, [aniSeasons]);

  // Fetch episodes from provider
  const fetchEpisodesFromProvider = useCallback(async (provider: Provider) => {
    const aniSelectedTitle = selectedSeason !== 'ALL' ? (selectedSeason as any).title?.userPreferred || (selectedSeason as any).title?.romaji : undefined;
    const seasonTitleCandidate = aniSelectedTitle || currentSeason?.title.userPreferred || currentSeason?.title.romaji;
    const normQuery = normalizeTitleForMatch(currentAnimeTitle || animeTitle);
    const normSeason = normalizeTitleForMatch(seasonTitleCandidate);
    const titleToUse = normSeason && (normSeason === normQuery || normQuery.includes(normSeason))
      ? (seasonTitleCandidate || currentAnimeTitle || animeTitle)
      : (currentAnimeTitle || seasonTitleCandidate || animeTitle);
    const anilistIdToUse = (selectedSeason !== 'ALL' ? (selectedSeason as any).id : undefined) || currentSeason?.id || anilistId;
    
    setProviderLoading(true);
    setProviderError(null);
    
    try {
      let fetchedEpisodes: Episode[] = [];
      
      if (provider === 'animepahe') {
        let animeId: string | null = null;
        
        if (anilistIdToUse) {
          animeId = await animePaheProvider.getAnimeIdByAnilistId(anilistIdToUse);
        } else if (titleToUse) {
          animeId = await animePaheProvider.getAnimeIdByTitle(titleToUse);
        }
        
        if (!animeId) {
          throw new Error(`Could not resolve anime ID for: ${titleToUse || anilistIdToUse}`);
        }
        
        setAnimePaheAnimeId(animeId);
        fetchedEpisodes = await animePaheProvider.getEpisodes(animeId);
        
        fetchedEpisodes = fetchedEpisodes.map(ep => ({
          ...ep,
          providerIds: { animepahe: animeId }
        }));
        
      } else if (provider === 'xl') {
        if (!anilistIdToUse) {
          throw new Error('AniList ID is required for XL provider');
        }
        
        fetchedEpisodes = await xlProvider.getEpisodes(anilistIdToUse);
        
        fetchedEpisodes = fetchedEpisodes.map(ep => ({
          ...ep,
          providerIds: { xl: String(anilistIdToUse) }
        }));
        
      } else if (provider === 'animezone') {
        // AnimeZone uses AnimePahe for episode list
        if (titleToUse) {
          const animePaheId = await animePaheProvider.getAnimeIdByTitle(titleToUse);
          if (animePaheId) {
            const animePaheEpisodes = await animePaheProvider.getEpisodes(animePaheId);
            const currentAudioPreference = sourceSettings.preferredType || 'sub';
            fetchedEpisodes = animePaheEpisodes.map((ep: any) => ({
              id: `animezone_animepahe_${ep.number}`,
              number: ep.number,
              title: ep.title || `Episode ${ep.number}`,
              image: ep.image,
              isSubbed: currentAudioPreference === 'sub',
              isDubbed: currentAudioPreference === 'dub',
              provider: 'animezone',
              aired: ep.aired,
              description: ep.description,
              duration: ep.duration,
              providerIds: {
                animezone: 'animepahe_fallback',
                animepahe: animePaheId
              }
            }));
          }
        }
      }
      
      setProviderEpisodes(fetchedEpisodes);
      
    } catch (error: any) {
      let errorMessage = `Failed to fetch episodes from ${provider}`;
      if (error?.response?.status === 404) {
        errorMessage = `Season not found on ${getProviderName(provider)}. Try switching providers.`;
      } else if (error?.code === 'ERR_NETWORK') {
        errorMessage = `Network error. Please check your connection and try again.`;
      } else if (error?.message) {
        errorMessage = `${getProviderName(provider)} error: ${error.message}`;
      }
      
      setProviderError(errorMessage);
      setProviderEpisodes([]);
    } finally {
      setProviderLoading(false);
    }
  }, [animeTitle, anilistId, currentSeason, currentAnimeTitle, sourceSettings, selectedSeason]);

  // Effects
  useEffect(() => {
    if (anilistId && animeTitle) {
      fetchRelatedSeasonsData(anilistId, animeTitle);
    }
  }, [anilistId, animeTitle, fetchRelatedSeasonsData]);

  useEffect(() => {
    if (currentProvider && (currentProvider !== sourceSettings.defaultProvider || providerEpisodes.length === 0)) {
      fetchEpisodesFromProvider(currentProvider);
    }
  }, [currentProvider, fetchEpisodesFromProvider]);

  useEffect(() => {
    fetchAniListProgress();
  }, [fetchAniListProgress]);

  useEffect(() => {
    const sub1 = DeviceEventEmitter.addListener('refreshMediaLists', fetchAniListProgress);
    const sub2 = DeviceEventEmitter.addListener('refreshWatchlist', fetchAniListProgress);
    return () => {
      sub1.remove();
      sub2.remove();
    };
  }, [fetchAniListProgress]);

  // Fetch Jikan metadata
  useEffect(() => {
    const fetchJikanMetadata = async () => {
      if (!malId) return;
      
      setJikanLoading(true);
      try {
        const episodesData = await fetchJikanEpisodes(Number(malId)).catch(() => []);
        if (episodesData && episodesData.length > 0) {
          setJikanEpisodes(episodesData);
        }
      } catch (error) {
        // Silent fail
      } finally {
        setJikanLoading(false);
      }
    };
    
    fetchJikanMetadata();
  }, [malId]);

  // Merge Jikan metadata
  const mergeJikanMetadata = useCallback((episodes: Episode[], jikanEps: JikanEpisode[]): Episode[] => {
    if (!jikanEps || jikanEps.length === 0) return episodes;
    
    return episodes.map(episode => {
      const jikanEp = jikanEps.find(jep => jep.mal_id === episode.number);
      if (!jikanEp) return episode;
      
      return {
        ...episode,
        title: jikanEp.title || episode.title,
        aired: jikanEp.aired || episode.aired,
        isFiller: jikanEp.filler || episode.isFiller || false,
        isRecap: jikanEp.recap || episode.isRecap || false,
        duration: jikanEp.duration || episode.duration,
      };
    });
  }, []);

  // Process episodes
  const episodesToProcess = providerEpisodes.length > 0 ? providerEpisodes : episodes;
  const episodesWithJikanMetadata = useMemo(() => {
    return mergeJikanMetadata(episodesToProcess, jikanEpisodes);
  }, [episodesToProcess, jikanEpisodes, mergeJikanMetadata]);
  
  const processedEpisodes = useMemo(() => {
    if (!episodesWithJikanMetadata || episodesWithJikanMetadata.length === 0) return [];
    
    const sorted = [...episodesWithJikanMetadata].sort((a, b) => {
      const aNum = a.number ?? 0;
      const bNum = b.number ?? 0;
      return isNewestFirst ? bNum - aNum : aNum - bNum;
    });
    
    return sorted;
  }, [episodesWithJikanMetadata, isNewestFirst]);

  // Episode ranges for pagination
  const createEpisodeRanges = useCallback((episodesList: Episode[]) => {
    const ranges: Record<string, Episode[]> = {};
    const totalEpisodes = episodesList.length;
    
    if (totalEpisodes <= 12) {
      ranges['All'] = episodesList;
    } else {
      const rangeSize = 12;
      const numRanges = Math.ceil(totalEpisodes / rangeSize);
      
      for (let i = 0; i < numRanges; i++) {
        const start = i * rangeSize;
        const end = Math.min(start + rangeSize, totalEpisodes);
        const rangeEpisodes = episodesList.slice(start, end);
        
        const firstEp = rangeEpisodes[0].number || 0;
        const lastEp = rangeEpisodes[rangeEpisodes.length - 1].number || 0;
        
        const rangeKey = isNewestFirst
          ? `${Math.max(firstEp, lastEp)}-${Math.min(firstEp, lastEp)}`
          : `${Math.min(firstEp, lastEp)}-${Math.max(firstEp, lastEp)}`;
        
        ranges[rangeKey] = rangeEpisodes;
      }
    }
    
    return ranges;
  }, [isNewestFirst]);

  useEffect(() => {
    const ranges = createEpisodeRanges(processedEpisodes);
    setEpisodeRanges(ranges);
    
    const rangeKeys = Object.keys(ranges);
    if (rangeKeys.length > 0 && !ranges[activeTab]) {
      setActiveTab(rangeKeys[0]);
    }
  }, [processedEpisodes, createEpisodeRanges, activeTab]);

  // Load episode progress
  useEffect(() => {
    const loadEpisodeProgress = async () => {
      if (!anilistId || episodesToProcess.length === 0) return;
      
      try {
        const progressData: Record<string, EpisodeProgress> = {};
        
        for (const episode of episodesToProcess.slice(0, 20)) {
          const keys = [
            `episode_progress_${anilistId}_${episode.number}`,
            `progress_anilist_${anilistId}_ep_${episode.number}`,
          ];
          
          for (const key of keys) {
            const stored = await AsyncStorage.getItem(key);
            if (stored) {
              const progressInfo = JSON.parse(stored);
              if (progressInfo.timestamp !== undefined) {
                progressData[episode.id] = {
                  timestamp: progressInfo.timestamp,
                  duration: progressInfo.duration || 0,
                  percentage: progressInfo.percentage || 0,
                };
              }
              break;
            }
          }
        }
        
        setEpisodeProgressMap(progressData);
      } catch (error) {
        // Silent fail
      }
    };

    loadEpisodeProgress();
  }, [anilistId, episodes, providerEpisodes]);

  // Audio type availability
  const audioTypeAvailability = useMemo(() => {
    const episodesToCheck = providerEpisodes.length > 0 ? providerEpisodes : episodes;
    
    if (currentProvider === 'xl' || currentProvider === 'animezone') {
      return { sub: true, dub: true };
    }
    
    const hasSubbed = episodesToCheck.some(ep => ep.isSubbed === true);
    const hasDubbed = episodesToCheck.some(ep => ep.isDubbed === true);
    
    return { sub: hasSubbed, dub: hasDubbed };
  }, [episodes, providerEpisodes.length, currentProvider]);

  const canToggle = audioTypeAvailability.sub && audioTypeAvailability.dub;

  // Event handlers
  const handleEpisodePress = useCallback((episode: Episode) => {
    let episodeId = '';
    if (currentProvider === 'animepahe' && episode.providerIds?.animepahe) {
      episodeId = `${episode.providerIds.animepahe}/episode-${episode.number}`;
    } else if (currentProvider === 'animezone') {
      episodeId = `${animeTitle}?ep=${episode.number}`;
    } else if (currentProvider === 'xl') {
      episodeId = `${anilistId}?ep=${episode.number}`;
    } else {
      episodeId = `${anilistId}?ep=${episode.number}`;
    }
    
    setSelectedEpisode(episode);
    setModalVisible(true);
  }, [currentProvider, anilistId, animeTitle]);

  const handleSourceSelect = useCallback((url: string, headers: any, episodeId: string, episodeNumber: string, subtitles?: any[], timings?: any, anilistIdParam?: string, dataKey?: string, provider?: string, audioType?: AudioType) => {
    if (!selectedEpisode) return;
    
    router.push({
      pathname: '/player',
      params: {
        episodeId,
        animeTitle,
        episodeNumber,
        source: url,
        anilistId: anilistIdParam || anilistId,
        malId: malId,
        dataKey,
        provider: provider || currentProvider,
        audioType: audioType || preferredAudioType
      },
    });
    
    setModalVisible(false);
  }, [selectedEpisode, animeTitle, anilistId, malId, router, currentProvider, preferredAudioType]);

  const handleAudioTypeToggle = useCallback(() => {
    if (!canToggle) return;
    const newType = preferredAudioType === 'sub' ? 'dub' : 'sub';
    setPreferredAudioType(newType);
    
    AsyncStorage.setItem('sourceSettings', JSON.stringify({
      ...sourceSettings,
      preferredType: newType
    })).catch(console.error);
  }, [preferredAudioType, canToggle, sourceSettings]);

  const handleAudioError = useCallback((episode: Episode, requestedType: AudioType) => {
    // Could show toast here
  }, []);

  const handleSortToggle = useCallback(() => {
    setIsNewestFirst(!isNewestFirst);
    const ranges = createEpisodeRanges(processedEpisodes);
    const rangeKeys = Object.keys(ranges);
    if (rangeKeys.length > 0) {
      setActiveTab(rangeKeys[0]);
    }
  }, [isNewestFirst, createEpisodeRanges, processedEpisodes]);

  const handleColumnToggle = useCallback(() => {
    setColumnCount(columnCount === 1 ? 2 : 1);
  }, [columnCount]);

  const handleNotificationToggle = useCallback(async () => {
    if (!anilistId) return;
    
    const episodesToUse = providerEpisodes.length > 0 ? providerEpisodes : episodes;
    
    try {
      if (!notificationsEnabled) {
        const hasPermission = await requestNotificationPermissions();
        if (!hasPermission) return;
      }
      
      await toggleNotifications({
        id: anilistId,
        type: 'anime',
        title: animeTitle,
        lastKnownNumber: Math.max(...episodesToUse.map(ep => ep.number || 0))
      });
      
      const enabled = await isNotificationEnabled(anilistId);
      setNotificationsEnabled(enabled);
    } catch (error) {
      console.error('Failed to toggle notifications:', error);
    }
  }, [anilistId, animeTitle, episodes, providerEpisodes, notificationsEnabled]);

  const handleProviderChange = useCallback((provider: Provider) => {
    setCurrentProvider(provider);
    setShowProviderDropdown(false);
    setIsBackgroundRefreshing(true);
    
    AsyncStorage.setItem('sourceSettings', JSON.stringify({
      ...sourceSettings,
      defaultProvider: provider
    })).catch(console.error);
    
    fetchEpisodesFromProvider(provider).finally(() => {
      setIsBackgroundRefreshing(false);
    });
  }, [sourceSettings, fetchEpisodesFromProvider]);

  const handleAnimeSelect = useCallback((anime: any) => {
    setCurrentAnimeTitle(anime.title);
    setShowCorrectAnimeModal(false);
    setProviderEpisodes([]);
    setProviderError(null);
    fetchEpisodesFromProvider(currentProvider);
  }, [currentProvider, fetchEpisodesFromProvider]);

  const handleSeasonChange = useCallback((season: Season) => {
    setCurrentSeason(season);
    setShowSeasonDropdown(false);
    setProviderEpisodes([]);
    setProviderError(null);
    
    const newTitle = season.title.userPreferred || season.title.romaji || season.title.english || '';
    setCurrentAnimeTitle(newTitle);
    fetchEpisodesFromProvider(currentProvider);
  }, [currentProvider, fetchEpisodesFromProvider]);

  const getProviderName = useCallback((provider: string) => {
    return provider === 'animepahe' ? 'AnimePahe' : provider === 'xl' ? 'XL (Zuko)' : 'AnimeZone';
  }, []);

  const renderItem = useCallback(({ item, index }: { item: Episode; index: number }) => {
    const episodeProgress = episodeProgressMap[item.id];
    
    return (
      <View style={styles.cardWrapper}>
        <EpisodeCard
          episode={item}
          onPress={handleEpisodePress}
          currentProgress={currentProgress}
          currentTheme={currentTheme}
          isDarkMode={isDarkMode}
          coverImage={coverImage}
          index={index}
          isVisible={true}
          preferredAudioType={preferredAudioType}
          onAudioError={handleAudioError}
          episodeProgress={episodeProgress}
          isGrid={columnCount === 2}
        />
      </View>
    );
  }, [columnCount, handleEpisodePress, currentProgress, currentTheme, isDarkMode, coverImage, preferredAudioType, handleAudioError, episodeProgressMap]);

  // Filter Card Component
  const renderFilterCard = () => {
    return (
      <View style={[styles.filterCard, { backgroundColor: currentTheme.colors.surface }]}>
        <View style={styles.filterRow}>
          <View style={styles.filterSection}>
            <Text style={[styles.filterLabel, { color: currentTheme.colors.textSecondary }]}>Anime Title</Text>
            <TouchableOpacity 
              style={[styles.filterDropdown, { borderColor: currentTheme.colors.border }]}
              onPress={() => setShowCorrectAnimeModal(true)}
            >
              <Text style={[styles.filterDropdownText, { color: currentTheme.colors.text }]} numberOfLines={1}>
                {currentAnimeTitle}
              </Text>
              <FontAwesome5 name="chevron-down" size={12} color={currentTheme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.filterTripleRow}>
          {availableSeasons.length > 1 && (
            <View style={styles.filterSectionSmall}>
              <Text style={[styles.filterLabelSmall, { color: currentTheme.colors.textSecondary }]}>Season</Text>
              <TouchableOpacity
                style={[styles.filterDropdownSmall, { borderColor: currentTheme.colors.border }]}
                onPress={() => setShowSeasonDropdown(!showSeasonDropdown)}
                disabled={seasonsLoading}
              >
                <Text style={[styles.filterDropdownTextSmall, { color: currentTheme.colors.text }]} numberOfLines={2}>
                  {currentSeason
                    ? `${currentSeason.title.userPreferred || currentSeason.title.romaji || 'Season'}${currentSeason.startDate?.year ? ` (${currentSeason.startDate.year})` : ''}`
                    : 'Select season'}
                </Text>
                {seasonsLoading ? (
                  <ActivityIndicator size="small" color={currentTheme.colors.textSecondary} />
                ) : (
                  <FontAwesome5 name="chevron-down" size={10} color={currentTheme.colors.textSecondary} />
                )}
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.filterSectionSmall}>
            <Text style={[styles.filterLabelSmall, { color: currentTheme.colors.textSecondary }]}>Provider</Text>
            <TouchableOpacity 
              style={[styles.filterDropdownSmall, { borderColor: currentTheme.colors.border }]}
              onPress={() => setShowProviderDropdown(!showProviderDropdown)}
            >
              <Text style={[styles.filterDropdownTextSmall, { color: currentTheme.colors.text }]}>
                {getProviderName(currentProvider)}
              </Text>
              <FontAwesome5 name="chevron-down" size={10} color={currentTheme.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.filterSectionSmall}>
            <Text style={[styles.filterLabelSmall, { color: currentTheme.colors.textSecondary }]}>Language</Text>
            <TouchableOpacity 
              style={[
                styles.filterDropdownSmall, 
                { borderColor: currentTheme.colors.border },
                !canToggle && styles.filterDropdownDisabled
              ]}
              onPress={canToggle ? handleAudioTypeToggle : undefined}
              disabled={!canToggle}
            >
              <Text style={[
                styles.filterDropdownTextSmall, 
                { color: currentTheme.colors.text },
                !canToggle && styles.filterDropdownTextDisabled
              ]}>
                {preferredAudioType.toUpperCase()}
              </Text>
              <FontAwesome5 name="chevron-down" size={10} color={currentTheme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
        
        <View style={styles.filterActionsRow}>
          <TouchableOpacity 
            style={[styles.refreshButton, { backgroundColor: currentTheme.colors.primary }]}
            onPress={() => fetchEpisodesFromProvider(currentProvider)}
          >
            <FontAwesome5 name="sync-alt" size={12} color="#FFFFFF" />
            <Text style={styles.refreshButtonText}>Refresh</Text>
          </TouchableOpacity>
          
          {notificationsEnabled && (
            <View style={styles.notificationIndicator}>
              <FontAwesome5 name="bell" size={12} color="#02A9FF" />
              <Text style={[styles.notificationText, { color: currentTheme.colors.textSecondary }]}>
                Notifications On
              </Text>
            </View>
          )}
        </View>

        {showSeasonDropdown && availableSeasons.length > 1 && (
          <View style={[styles.inlineDropdown, { backgroundColor: currentTheme.colors.surface, borderColor: currentTheme.colors.border }]}>
            <ScrollView style={styles.inlineDropdownScroll} nestedScrollEnabled={true}>
              {availableSeasons.map((season) => (
                <TouchableOpacity
                  key={season.id}
                  style={[
                    styles.inlineDropdownItem,
                    currentSeason?.id === season.id && styles.inlineDropdownItemActive,
                    { borderBottomColor: currentTheme.colors.border }
                  ]}
                  onPress={() => handleSeasonChange(season)}
                >
                  <Text style={[
                    styles.inlineDropdownItemText,
                    { color: currentTheme.colors.text },
                    currentSeason?.id === season.id && styles.inlineDropdownItemTextActive,
                  ]} numberOfLines={2}>
                    {season.title.userPreferred || season.title.romaji || season.title.english || 'Season'}
                  </Text>
                  <Text style={[styles.inlineDropdownItemMeta, { color: currentTheme.colors.textSecondary }]}>
                    {season.startDate?.year || 'Unknown'} • {season.episodes || '?'} eps
                  </Text>
                  {currentSeason?.id === season.id && (
                    <FontAwesome5 name="check" size={12} color={currentTheme.colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
        
        {showProviderDropdown && (
          <View style={[styles.inlineDropdown, { backgroundColor: currentTheme.colors.surface, borderColor: currentTheme.colors.border }]}>
            {(['animepahe', 'xl', 'animezone'] as const).map((provider) => (
              <TouchableOpacity
                key={provider}
                style={[
                  styles.inlineDropdownItem,
                  currentProvider === provider && styles.inlineDropdownItemActive,
                  { borderBottomColor: currentTheme.colors.border }
                ]}
                onPress={() => handleProviderChange(provider)}
              >
                <View style={[
                  styles.providerDot,
                  { backgroundColor: provider === 'animepahe' ? '#4CAF50' : provider === 'xl' ? '#9C27B0' : '#2196F3' }
                ]} />
                <Text style={[
                  styles.inlineDropdownItemText,
                  { color: currentTheme.colors.text },
                  currentProvider === provider && styles.inlineDropdownItemTextActive
                ]}>
                  {getProviderName(provider)}
                </Text>
                {currentProvider === provider && (
                  <FontAwesome5 name="check" size={12} color={currentTheme.colors.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {isBackgroundRefreshing && (
          <View style={styles.statusMessage}>
            <ActivityIndicator size="small" color="#02A9FF" />
            <Text style={[styles.statusMessageText, { color: currentTheme.colors.textSecondary }]}>
              Switching to {getProviderName(currentProvider)}...
            </Text>
          </View>
        )}
      </View>
    );
  };

  // Continue Watching Banner
  const renderContinueWatchingBanner = () => {
    const episodesToUse = providerEpisodes.length > 0 ? providerEpisodes : episodes;
    const nextEpisode = episodesToUse.find((ep: Episode) => ep.number === currentProgress + 1);
    if (!nextEpisode) return null;

    return (
      <TouchableOpacity
        style={[styles.continueBanner, { backgroundColor: currentTheme.colors.surface }]}
        onPress={() => handleEpisodePress(nextEpisode)}
      >
        <View style={styles.continueContent}>
          <View style={styles.continueThumbnail}>
            <OptimizedImage
              uri={nextEpisode.image || coverImage || ''}
              width={60}
              height={40}
              style={styles.continueImage}
              placeholder={PLACEHOLDER_BLUR_HASH}
              resizeMode="cover"
              isVisible={true}
              priority="high"
              reduceMemoryUsage={false}
              index={0}
            />
            <View style={styles.continuePlayIcon}>
              <FontAwesome5 name="play" size={12} color="#FFFFFF" />
            </View>
          </View>
          <View style={styles.continueText}>
            <Text style={[styles.continueTitle, { color: currentTheme.colors.text }]}>
              Continue Watching: Ep {nextEpisode.number}
            </Text>
            <Text style={[styles.continueSubtitle, { color: currentTheme.colors.textSecondary }]} numberOfLines={1}>
              {nextEpisode.title || `Episode ${nextEpisode.number}`}
            </Text>
          </View>
          <View style={styles.continueButton}>
            <Text style={styles.continueButtonText}>▶ Resume</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // Episode Range Tabs
  const renderEpisodeRangeTabs = () => {
    const rangeKeys = Object.keys(episodeRanges);
    if (rangeKeys.length <= 1) return null;

    return (
      <View style={styles.rangeTabsContainer}>
        <FlatList
          data={rangeKeys}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.rangeTab,
                activeTab === item && [styles.rangeTabActive, { backgroundColor: currentTheme.colors.primary }],
                { borderColor: currentTheme.colors.border }
              ]}
              onPress={() => setActiveTab(item)}
            >
              <Text style={[
                styles.rangeTabText,
                { color: currentTheme.colors.text },
                activeTab === item && styles.rangeTabTextActive
              ]}>
                {item === 'All' ? 'All Episodes' : `Episodes ${item}`}
              </Text>
            </TouchableOpacity>
          )}
          keyExtractor={(item) => item}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rangeTabsList}
        />
      </View>
    );
  };

  // Episode Header
  const renderEpisodeHeader = () => {
    const episodesToUse = providerEpisodes.length > 0 ? providerEpisodes : episodes;
    const fillerCount = processedEpisodes.filter(ep => ep.isFiller).length;
    const recapCount = processedEpisodes.filter(ep => ep.isRecap).length;
    
    return (
      <View style={styles.episodeHeader}>
        <View style={styles.episodeHeaderLeft}>
          <View style={styles.episodeHeaderTitleRow}>
            <Text style={[styles.episodeHeaderTitle, { color: currentTheme.colors.text }]}>
              Episodes
            </Text>
            {jikanEpisodes.length > 0 && (
              <View style={[styles.jikanBadge, { backgroundColor: currentTheme.colors.primary }]}>
                <Text style={styles.jikanBadgeText}>MAL ✓</Text>
              </View>
            )}
            {jikanLoading && (
              <ActivityIndicator size="small" color={currentTheme.colors.primary} style={{ marginLeft: 8 }} />
            )}
          </View>
          <View style={styles.episodeMetaRow}>
            <Text style={[styles.episodeHeaderCount, { color: currentTheme.colors.textSecondary }]}>
              {episodesToUse.length} episodes
            </Text>
            {jikanEpisodes.length > 0 && (fillerCount > 0 || recapCount > 0) && (
              <Text style={[styles.episodeMetaStats, { color: currentTheme.colors.textSecondary }]}>
                {fillerCount > 0 && ` • ${fillerCount} filler`}
                {recapCount > 0 && ` • ${recapCount} recap`}
              </Text>
            )}
          </View>
        </View>
        <View style={styles.episodeHeaderRight}>
          <TouchableOpacity 
            style={[styles.headerButton, { backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)' }]} 
            onPress={handleSortToggle}
          >
            <FontAwesome5 name={isNewestFirst ? "sort-numeric-down" : "sort-numeric-up"} size={14} color={currentTheme.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.headerButton, { backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)' }]} 
            onPress={handleColumnToggle}
          >
            <FontAwesome5 name={columnCount === 1 ? "th-large" : "th-list"} size={14} color={currentTheme.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={[
              styles.headerButton, 
              notificationsEnabled && styles.headerButtonActive,
              { backgroundColor: notificationsEnabled ? currentTheme.colors.primary : (isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)') }
            ]} 
            onPress={handleNotificationToggle}
          >
            <FontAwesome5 name={notificationsEnabled ? "bell" : "bell-slash"} size={14} color={notificationsEnabled ? "#FFFFFF" : currentTheme.colors.text} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Render
  const isLoading = loading || providerLoading || isBackgroundRefreshing;
  const episodesToShow = providerEpisodes.length > 0 ? providerEpisodes : episodes;
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  
  if (isLoading && episodesToShow.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={currentTheme.colors.primary} />
        <Text style={[styles.emptyText, { color: currentTheme.colors.textSecondary }]}>
          {providerLoading ? `Loading episodes from ${getProviderName(currentProvider)}...` : 'Loading Episodes...'}
        </Text>
      </View>
    );
  }
  
  if (providerError && episodesToShow.length === 0) {
    return (
      <View style={styles.emptyEpisodes}>
        <FontAwesome5 name="exclamation-triangle" size={48} color={isDarkMode ? '#ff6666' : '#ff4444'} />
        <Text style={[styles.emptyText, { color: currentTheme.colors.textSecondary }]}>
          {providerError}
        </Text>
        <TouchableOpacity 
          style={[styles.retryButton, { backgroundColor: currentTheme.colors.primary, marginTop: 16 }]}
          onPress={() => fetchEpisodesFromProvider(currentProvider)}
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  
  if (!isLoading && episodesToShow.length === 0) {
    return (
      <View style={styles.emptyEpisodes}>
        <FontAwesome5 name="video-slash" size={48} color={isDarkMode ? '#666' : '#ccc'} />
        <Text style={[styles.emptyText, { color: currentTheme.colors.textSecondary }]}>
          No episodes available from {getProviderName(currentProvider)} for this series yet.
        </Text>
      </View>
    );
  }

  const activeRange = episodeRanges[activeTab] || [];

  return (
    <View style={styles.container}>
      {(showProviderDropdown || showSeasonDropdown) && (
        <TouchableOpacity 
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => {
            setShowProviderDropdown(false);
            setShowSeasonDropdown(false);
          }}
        />
      )}

      {renderFilterCard()}
      {renderContinueWatchingBanner()}
      {renderEpisodeRangeTabs()}
      {renderEpisodeHeader()}

      <FlashList
        ref={flashListRef}
        data={activeRange}
        renderItem={renderItem}
        keyExtractor={(item: Episode) => `episode-${item.id}`}
        numColumns={columnCount}
        key={columnCount}
        estimatedItemSize={columnCount === 1 ? 140 : 220}
        contentContainerStyle={styles.listContentContainer}
      />

      <EpisodeSourcesModal
        visible={modalVisible}
        episodeId={selectedEpisode ? (
          currentProvider === 'animepahe' && selectedEpisode.providerIds?.animepahe
            ? `${selectedEpisode.providerIds.animepahe}/episode-${selectedEpisode.number}`
            : currentProvider === 'animezone'
            ? `${animeTitle}?ep=${selectedEpisode.number}`
            : currentProvider === 'xl'
            ? `${anilistId}?ep=${selectedEpisode.number}`
            : `${anilistId}?ep=${selectedEpisode.number}`
        ) : ''}
        onClose={() => setModalVisible(false)}
        onSelectSource={handleSourceSelect}
        preferredType={preferredAudioType}
        animeTitle={animeTitle}
        anilistId={anilistId}
        malId={malId}
        currentProvider={currentProvider}
        skipTypeSelection={true}
        episodeNumber={selectedEpisode?.number}
      />

      <CorrectAnimeSearchModal
        visible={showCorrectAnimeModal}
        onClose={() => setShowCorrectAnimeModal(false)}
        onSelectAnime={handleAnimeSelect}
        initialQuery={currentAnimeTitle}
        currentProvider={currentProvider}
        onProviderChange={(provider: string) => handleProviderChange(provider as Provider)}
      />
    </View>
  );
};

export default EpisodeList;

// Styles
const styles = StyleSheet.create({
  container: { flex: 1, width: '100%' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyEpisodes: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  emptyText: { marginTop: 16, fontSize: 16, textAlign: 'center' },
  retryButton: { padding: 12, borderRadius: 12, minWidth: 100, alignItems: 'center' },
  retryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  
  // Filter Card
  filterCard: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    borderRadius: 16,
    padding: 20,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  filterRow: { marginBottom: 16 },
  filterSection: { gap: 8 },
  filterLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  filterDropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  filterDropdownText: { fontSize: 16, fontWeight: '600', flex: 1 },
  filterTripleRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  filterSectionSmall: { flex: 1, gap: 6 },
  filterLabelSmall: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  filterDropdownSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    minHeight: 40,
  },
  filterDropdownTextSmall: { fontSize: 13, fontWeight: '600', flex: 1 },
  filterDropdownDisabled: { opacity: 0.5 },
  filterDropdownTextDisabled: { opacity: 0.6 },
  filterActionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 8,
  },
  refreshButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  notificationIndicator: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notificationText: { fontSize: 12, fontWeight: '500' },
  
  // Dropdowns
  inlineDropdown: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: 200,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  inlineDropdownScroll: { maxHeight: 200 },
  inlineDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  inlineDropdownItemActive: { backgroundColor: 'rgba(2, 169, 255, 0.1)' },
  inlineDropdownItemText: { fontSize: 14, fontWeight: '500', flex: 1 },
  inlineDropdownItemTextActive: { fontWeight: '600', color: '#02A9FF' },
  inlineDropdownItemMeta: { fontSize: 12, fontWeight: '400' },
  providerDot: { width: 8, height: 8, borderRadius: 4 },
  statusMessage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingTop: 12, gap: 8 },
  statusMessageText: { fontSize: 13, fontWeight: '500' },
  
  // Continue Watching
  continueBanner: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  continueContent: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  continueThumbnail: {
    width: 60,
    height: 40,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
    marginRight: 16,
  },
  continueImage: { width: '100%', height: '100%' },
  continuePlayIcon: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  continueText: { flex: 1 },
  continueTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  continueSubtitle: { fontSize: 12, fontWeight: '400' },
  continueButton: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#02A9FF', borderRadius: 8 },
  continueButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  
  // Range Tabs
  rangeTabsContainer: { marginBottom: 12 },
  rangeTabsList: { paddingHorizontal: 16, gap: 8 },
  rangeTab: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginRight: 8,
  },
  rangeTabActive: { borderColor: '#02A9FF', shadowColor: '#02A9FF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 4 },
  rangeTabText: { fontSize: 13, fontWeight: '600' },
  rangeTabTextActive: { color: '#FFFFFF' },
  
  // Episode Header
  episodeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 8,
  },
  episodeHeaderLeft: { gap: 4 },
  episodeHeaderTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  episodeHeaderTitle: { fontSize: 20, fontWeight: '700' },
  episodeMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  episodeHeaderCount: { fontSize: 13, fontWeight: '500' },
  episodeMetaStats: { fontSize: 12, fontWeight: '500' },
  jikanBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, elevation: 2 },
  jikanBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  episodeHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerButton: {
    padding: 10,
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerButtonActive: { shadowColor: '#02A9FF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 4 },
  
  // List
  dropdownOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 },
  listContentContainer: { paddingHorizontal: 10, paddingBottom: Platform.OS === 'ios' ? 100 : 90 },
  cardWrapper: { flex: 1, padding: 6 },
  
  // Grid Card
  gridCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    marginBottom: 4,
  },
  gridThumbnailContainer: { width: '100%', aspectRatio: 16 / 9, position: 'relative' },
  gridThumbnail: { width: '100%', height: '100%' },
  gridContent: { padding: 16 },
  gridTitle: { fontSize: 16, fontWeight: '700', lineHeight: 22, marginBottom: 12 },
  watchedGridCard: { opacity: 0.8 },
  
  // List Card
  listCard: {
    flexDirection: 'row',
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 12,
    alignItems: 'flex-start',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
    marginBottom: 3,
  },
  listThumbnailContainer: { position: 'relative' },
  listThumbnail: { width: 110, height: 75, borderRadius: 8, marginRight: 16 },
  listContent: { flex: 1, justifyContent: 'space-between' },
  listTitle: { fontSize: 16, fontWeight: '700', lineHeight: 22, marginBottom: 8 },
  watchedListCard: { backgroundColor: '#2c2c2e' },
  
  // Shared
  episodeNumberBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  episodeNumberText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  watchedBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#17C964',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: 'rgba(0,0,0,0.15)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.8,
    shadowRadius: 2,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)'
  },
  watchedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: 8,
  },
  watchedThumbnail: { opacity: 0.6 },
  unavailableCard: { opacity: 0.6, borderWidth: 1, borderColor: '#FF4444' },
  unavailableText: { opacity: 0.7 },
  unavailableThumbnail: { opacity: 0.4 },
  unavailableBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(255, 68, 68, 0.9)',
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1c1c1e',
  },
  
  // Meta
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  audioPills: { flexDirection: 'row', gap: 8 },
  audioPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  subPill: { backgroundColor: 'rgba(76, 175, 80, 0.9)' },
  dubPill: { backgroundColor: 'rgba(255, 152, 0, 0.9)' },
  fillerPill: { backgroundColor: 'rgba(255, 107, 53, 0.9)' },
  preferredPill: { opacity: 1, shadowOpacity: 0.4, elevation: 4, transform: [{ scale: 1.05 }] },
  pillText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  dateText: { fontSize: 12, fontWeight: '500' },
  
  // Watch Button
  watchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#02A9FF',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    shadowColor: '#02A9FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
  },
  rewatchButton: { backgroundColor: '#01579B', shadowColor: '#01579B' },
  unavailableButton: { backgroundColor: '#FF4444' },
  watchButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', marginLeft: 4 },
  
  // Progress
  progressContainer: { marginTop: 12 },
  progressBarBackground: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#02A9FF',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
});
