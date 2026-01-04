import { Chapter, Provider } from './index';
import { MangaDexProvider } from './mangadx';
import KatanaProvider from './katana';
import MangaFireProvider from './mangafire';
import axios from 'axios';

export interface SearchResult {
  id: string;
  title: string;
  source: Provider;
  coverImage?: string;
  status?: string;
  genres?: string[];
  summary?: string;
  chapterCount?: number;
  lastUpdated?: string;
}

export interface ProviderPreferences {
  defaultProvider: Provider;
  autoSelectSource: boolean;
  preferredChapterLanguage: string;
}

export interface PageWithHeaders {
  url: string;
  headers?: Record<string, string>;
}

export class MangaProviderService {
  private static logDebug = (message: string, data?: any) => 
    console.log(`[MangaProviderService DEBUG] ${message}`, data || '');
  
  private static logError = (message: string, error?: any) => 
    console.error(`[MangaProviderService ERROR] ${message}`, error || '');
  
  // Cache for thumbnail pages to avoid re-fetching
  private static thumbnailCache = new Map<string, PageWithHeaders | null>();

  /**
   * Extract the first meaningful keyword from a manga title for searching
   */
  private static extractFirstKeyword(title: string): string {
    // Remove common prefixes and suffixes that don't help with search
    let cleaned = title
      .replace(/^[【「『]/, '') // Remove opening brackets/quotes
      .replace(/[】」』]$/, '') // Remove closing brackets/quotes
      .replace(/[★☆♪♫♥♡◆◇▲△●○■□※！？：；，。]/g, '') // Remove decorative symbols
      .replace(/[（]/g, '(') // Normalize parentheses
      .replace(/[）]/g, ')') // Normalize parentheses
      .replace(/[【]/g, '[') // Normalize brackets
      .replace(/[】]/g, ']') // Normalize brackets
      .replace(/[「]/g, '"') // Normalize quotes
      .replace(/[」]/g, '"') // Normalize quotes
      .replace(/[『]/g, "'") // Normalize quotes
      .replace(/[』]/g, "'") // Normalize quotes
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .trim();

    // Split by common separators and get the first meaningful part
    const separators = [':', ' - ', ' – ', ' — ', ' | ', ' |', '| ', ' (', '（', ' [', '【'];
    
    for (const separator of separators) {
      if (cleaned.includes(separator)) {
        cleaned = cleaned.split(separator)[0].trim();
        break;
      }
    }

    // Extract the first 1-3 words as the keyword
    const words = cleaned.split(/\s+/).filter(word => 
      word.length > 1 && // Skip single characters
      !/^[0-9]+$/.test(word) && // Skip pure numbers
      !['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'].includes(word.toLowerCase())
    );

    // Return the first meaningful word or first two words if the first is very short
    if (words.length === 0) return cleaned;
    if (words[0].length <= 2 && words.length > 1) {
      return `${words[0]} ${words[1]}`.trim();
    }
    return words[0];
  }

  /**
   * Normalize manga title by removing problematic symbols and characters
   */
  private static normalizeTitle(title: string): string {
    return title
      .replace(/[★☆]/g, '') // Remove star symbols
      .replace(/[♪♫]/g, '') // Remove music symbols
      .replace(/[♥♡]/g, '') // Remove heart symbols
      .replace(/[◆◇]/g, '') // Remove diamond symbols
      .replace(/[▲△]/g, '') // Remove triangle symbols
      .replace(/[●○]/g, '') // Remove circle symbols
      .replace(/[■□]/g, '') // Remove square symbols
      .replace(/[※]/g, '') // Remove reference symbols
      .replace(/[！]/g, '!') // Normalize exclamation marks
      .replace(/[？]/g, '?') // Normalize question marks
      .replace(/[：]/g, ':') // Normalize colons
      .replace(/[；]/g, ';') // Normalize semicolons
      .replace(/[，]/g, ',') // Normalize commas
      .replace(/[。]/g, '.') // Normalize periods
      .replace(/[（]/g, '(') // Normalize parentheses
      .replace(/[）]/g, ')') // Normalize parentheses
      .replace(/[【]/g, '[') // Normalize brackets
      .replace(/[】]/g, ']') // Normalize brackets
      .replace(/[「]/g, '"') // Normalize quotes
      .replace(/[」]/g, '"') // Normalize quotes
      .replace(/[『]/g, "'") // Normalize quotes
      .replace(/[』]/g, "'") // Normalize quotes
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .trim(); // Remove leading/trailing whitespace
  }

  /**
   * Calculate similarity score between two titles
   */
  private static calculateTitleSimilarity(searchTitle: string, resultTitle: string): number {
    const normalizedSearch = this.normalizeTitle(searchTitle.toLowerCase());
    const normalizedResult = this.normalizeTitle(resultTitle.toLowerCase());
    
    // Exact match gets highest score
    if (normalizedSearch === normalizedResult) {
      return 100;
    }
    
    // Check if search title is contained in result title
    if (normalizedResult.includes(normalizedSearch)) {
      return 90;
    }
    
    // Check if result title is contained in search title
    if (normalizedSearch.includes(normalizedResult)) {
      return 85;
    }
    
    // Special handling for Japanese titles and their English equivalents
    const japaneseMappings: Record<string, string[]> = {
      'ウマ娘': ['uma musume', 'uma-musume'],
      'シンデレラグレイ': ['cinderella gray', 'cinderella-gray'],
      '地雷': ['landmine', 'dangerous', 'jirai'],
      '地原': ['chihara'],
      'なんですか': ['desu ka', 'what is', 'is it'],
      'jirai': ['地雷', 'landmine', 'dangerous'],
      'chihara': ['地原']
    };
    
    // Check for Japanese-English mappings
    for (const [japanese, english] of Object.entries(japaneseMappings)) {
      const searchHasTerm = normalizedSearch.includes(japanese) || english.some(e => normalizedSearch.includes(e));
      const resultHasTerm = normalizedResult.includes(japanese) || english.some(e => normalizedResult.includes(e));
      
      if (searchHasTerm && resultHasTerm) {
        // High score for matching Japanese-English pairs
        return 80;
      }
    }
    
    // Split into words and calculate word overlap
    // For Japanese, don't filter by length as single characters are valid
    const searchWords = normalizedSearch.split(/\s+/).filter(word => word.length > 0);
    const resultWords = normalizedResult.split(/\s+/).filter(word => word.length > 0);
    
    if (searchWords.length === 0 || resultWords.length === 0) {
      return 0;
    }
    
    let matchCount = 0;
    let totalScore = 0;
    
    for (const searchWord of searchWords) {
      for (const resultWord of resultWords) {
        if (resultWord.includes(searchWord) || searchWord.includes(resultWord)) {
          matchCount++;
          totalScore += Math.min(searchWord.length, resultWord.length);
        }
      }
    }
    
    if (matchCount === 0) {
      return 0;
    }
    
    // Calculate percentage of words matched
    const wordMatchPercentage = (matchCount / searchWords.length) * 100;
    
    // Bonus for matching at the beginning
    let positionBonus = 0;
    if (normalizedResult.startsWith(searchWords[0] || '')) {
      positionBonus = 10;
    }
    
    // Bonus for similar length
    const lengthDiff = Math.abs(normalizedResult.length - normalizedSearch.length);
    const lengthBonus = Math.max(0, 20 - lengthDiff);
    
    // Bonus for Japanese-English title matches
    const containsJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(searchTitle);
    const resultContainsJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(resultTitle);
    let japaneseBonus = 0;
    if (containsJapanese && !resultContainsJapanese) {
      // Bonus for finding English equivalent of Japanese title
      japaneseBonus = 15;
    }
    
    return Math.min(100, wordMatchPercentage + positionBonus + lengthBonus + japaneseBonus);
  }

  /**
   * Search for manga across providers with auto-fallback support
   */
  static async searchManga(
    title: string, 
    preferences: ProviderPreferences
  ): Promise<{ results: SearchResult[]; provider: Provider }> {
    const { defaultProvider, autoSelectSource } = preferences;
    
    // Extract first keyword for fallback search
    const firstKeyword = this.extractFirstKeyword(title);
    const normalizedTitle = this.normalizeTitle(title);
    
    this.logDebug(`Original title: "${title}"`);
    this.logDebug(`First keyword: "${firstKeyword}"`);
    this.logDebug(`Normalized title: "${normalizedTitle}"`);
    
    // Determine which providers to try
    const providersToTry: Provider[] = autoSelectSource 
      ? ['mangafire', 'mangadex'] // Try best sources first when auto-select is ON
      : [defaultProvider]; // Only try the selected provider when auto-select is OFF

    this.logDebug(`Auto-select is ${autoSelectSource ? 'ON' : 'OFF'}`);
    this.logDebug(`Will try providers in order:`, providersToTry);

    let lastError: any = null;

    for (const provider of providersToTry) {
      try {
        this.logDebug(`Trying provider: ${provider}`);
        
        let results: SearchResult[] = [];
        let bestResults: SearchResult[] = [];
        let bestScore = 0;

        // Try normalized title first (most accurate), then original title, then first keyword as fallback
        const titlesToTry = [normalizedTitle];
        if (title !== normalizedTitle) {
          titlesToTry.push(title);
        }
        if (firstKeyword !== normalizedTitle && firstKeyword !== title) {
          titlesToTry.push(firstKeyword);
        }

        for (const currentTitle of titlesToTry) {
          try {
            let currentResults: SearchResult[] = [];
            
            switch (provider) {
              case 'katana':
                const katanaResults = await KatanaProvider.search(currentTitle);
                currentResults = katanaResults.map(r => ({
                  id: r.id,
                  title: r.title,
                  source: 'katana' as Provider,
                  coverImage: r.coverImage,
                  status: r.status,
                  genres: r.genres,
                  summary: r.description,
                  lastUpdated: r.lastUpdated
                }));
                break;

              case 'mangadex':
                const mangadxUrl = MangaDexProvider.getSearchUrl(currentTitle);
                const mangadxResponse = await axios.get(mangadxUrl, {
                  headers: MangaDexProvider.getHeaders(),
                  timeout: 15000 // 15 second timeout
                });
                const mangadxData = mangadxResponse.data;
            
                if (mangadxData?.results) {
                  currentResults = mangadxData.results.map((r: any) => ({
                    id: r.id,
                    title: r.title,
                    source: 'mangadex' as Provider,
                    coverImage: r.image,
                    status: r.status,
                    genres: r.genres,
                    summary: r.description,
                    lastUpdated: r.lastUpdated
                  }));
                }
                break;

              case 'mangafire':
                // Pass original title for better similarity scoring
                const mangafireResults = await MangaFireProvider.search(currentTitle, 1, title);
                currentResults = mangafireResults.map(r => ({
                  id: r.id,
                  title: r.title,
                  source: 'mangafire' as Provider,
                  coverImage: r.coverImage,
                  status: r.status,
                  genres: r.genres,
                  summary: r.description,
                  lastUpdated: r.lastUpdated
                }));
                break;
            }

            // Collect all results and score them against the original title
            if (currentResults.length > 0) {
              results = [...results, ...currentResults];
              
              // Score results against original title for better matching
              const scoredResults = currentResults.map(r => {
                const score = this.calculateTitleSimilarity(title, r.title);
                return { result: r, score };
              });
              
              // Keep track of best scoring results
              const maxScore = Math.max(...scoredResults.map(s => s.score));
              if (maxScore > bestScore) {
                bestScore = maxScore;
                bestResults = currentResults;
              }
              
              // If we got high-quality results (score > 50), prefer these
              if (maxScore > 50 && currentTitle === normalizedTitle) {
                this.logDebug(`Found high-quality results (score: ${maxScore}) with normalized title`);
                break;
              }
            }
          } catch (titleError) {
            this.logDebug(`Title "${currentTitle}" failed for ${provider}:`, titleError);
            // Continue to next title variation
          }
        }

        // Remove duplicates based on ID and score them
        const uniqueResults = results.filter((result, index, self) => 
          index === self.findIndex(r => r.id === result.id)
        );

        if (uniqueResults.length > 0) {
          // Score and sort all unique results by similarity to original title
          const scoredUniqueResults = uniqueResults.map(result => ({
            result,
            score: this.calculateTitleSimilarity(title, result.title)
          })).sort((a, b) => b.score - a.score);

          // Extract just the results, now sorted by score
          const sortedResults = scoredUniqueResults.map(s => s.result);

          this.logDebug(`Successfully found ${sortedResults.length} results from ${provider}`);
          this.logDebug(`Top result score: ${scoredUniqueResults[0]?.score || 0}`);
          
          // Return sorted results (best matches first)
          return { results: sortedResults, provider };
        } else {
          throw new Error(`No results found on ${provider}`);
        }

      } catch (err: any) {
        lastError = err;
        this.logError(`Provider ${provider} failed:`, err.message);

        // If auto-select is OFF and this provider fails, don't try others
        if (!autoSelectSource) {
          break;
        }
      }
    }

    // If we get here, all providers failed
    throw lastError || new Error('All providers failed');
  }

  /**
   * Get chapters for a specific manga from a provider
   */
  static async getChapters(
    mangaId: string, 
    provider: Provider,
    coverImage?: string
  ): Promise<Chapter[]> {
    this.logDebug(`Getting chapters for ${mangaId} from ${provider}`);

    try {
      let chapters: Chapter[] = [];

      switch (provider) {
        case 'katana':
          const katanaChapters = await KatanaProvider.getChapters(mangaId);
          chapters = katanaChapters.map(ch => ({
            ...ch,
            thumbnail: coverImage,
            source: 'katana'
          }));
          break;

        case 'mangadex':
          const mangadxResponse = await MangaDexProvider.fetchInfo(mangaId);
          
          if (mangadxResponse.success) {
            chapters = MangaDexProvider.formatChaptersFromResponse(mangadxResponse.data, 'mangadex')
              .map(ch => ({
                ...ch,
                thumbnail: coverImage,
                source: 'mangadex'
              }));
          } else {
            throw new Error(mangadxResponse.data?.errorMessage || 'Failed to fetch manga info from MangaDex');
          }
          break;

        case 'mangafire':
          const mangafireChapters = await MangaFireProvider.getChapters(mangaId);
          chapters = mangafireChapters.map(ch => ({
            ...ch,
            thumbnail: coverImage,
            source: 'mangafire'
          }));
          break;
      }

      this.logDebug(`Successfully loaded ${chapters.length} chapters from ${provider}`);
      return chapters;

    } catch (error: any) {
      this.logError(`Failed to get chapters from ${provider}:`, error);
      throw error;
    }
  }

  /**
   * Get chapter pages for reading
   */
  static async getChapterPages(
    chapterId: string, 
    provider: Provider,
    mangaId?: string
  ): Promise<PageWithHeaders[]> {
    this.logDebug(`Getting pages for chapter ${chapterId} from ${provider}${mangaId ? ` (manga: ${mangaId})` : ''}`);

    try {
      let pages: PageWithHeaders[] = [];

      switch (provider) {
        case 'katana':
          const katanaResponse = await KatanaProvider.getChapterPages(chapterId);
          pages = katanaResponse.pages.map(p => ({
            url: p.url,
            headers: p.headers
          }));
          break;

        case 'mangadex':
          const mangadxResponse = await MangaDexProvider.fetchChapterPages(chapterId);
          
          if (mangadxResponse.success) {
            const urls = MangaDexProvider.parseChapterPagesResponse(mangadxResponse.data);
            pages = urls.map(url => ({
              url,
              headers: MangaDexProvider.getImageHeaders()
            }));
          } else {
            throw new Error(mangadxResponse.data?.errorMessage || 'Failed to fetch chapter pages');
          }
          break;

        case 'mangafire':
          if (!mangaId) {
            throw new Error('Manga ID is required for MangaFire provider');
          }
          const mangafireResponse = await MangaFireProvider.getChapterPages(chapterId, mangaId);
          pages = mangafireResponse.pages.map(p => ({
            url: p.url,
            headers: p.headers
          }));
          break;
      }

      this.logDebug(`Successfully loaded ${pages.length} pages from ${provider}`);
      return pages;

    } catch (error: any) {
      this.logError(`Failed to get chapter pages from ${provider}:`, error);
      throw error;
    }
  }

  /**
   * Get first page of a chapter for thumbnail preview
   * Uses caching to avoid re-fetching the same thumbnail
   */
  static async getChapterThumbnailPage(
    chapterId: string, 
    provider: Provider,
    mangaId?: string
  ): Promise<PageWithHeaders | null> {
    // Create cache key from chapter ID and provider
    const cacheKey = `${provider}:${chapterId}`;
    
    // Check cache first
    if (this.thumbnailCache.has(cacheKey)) {
      this.logDebug(`Using cached thumbnail for chapter ${chapterId} from ${provider}`);
      return this.thumbnailCache.get(cacheKey) || null;
    }

    this.logDebug(`Getting thumbnail page for chapter ${chapterId} from ${provider}`);

    try {
      const allPages = await this.getChapterPages(chapterId, provider, mangaId);
      // Return first page for thumbnail preview
      const thumbnailPage = allPages[0] || null;
      
      // Cache the result (even if null, to avoid retrying failed requests)
      this.thumbnailCache.set(cacheKey, thumbnailPage);
      
      // Limit cache size to prevent memory issues (keep last 100 thumbnails)
      if (this.thumbnailCache.size > 100) {
        const firstKey = this.thumbnailCache.keys().next().value;
        if (firstKey) {
          this.thumbnailCache.delete(firstKey);
        }
      }
      
      this.logDebug(`Successfully loaded thumbnail page from ${provider}`);
      return thumbnailPage;

    } catch (error: any) {
      // Cache null result for failed requests to avoid retrying
      this.thumbnailCache.set(cacheKey, null);
      this.logError(`Failed to get chapter thumbnail page from ${provider}:`, error);
      throw error;
    }
  }
  
  /**
   * Clear thumbnail cache (useful for memory management)
   */
  static clearThumbnailCache(): void {
    this.thumbnailCache.clear();
  }

  /**
   * Get error message based on provider and auto-select setting
   */
  static getProviderErrorMessage(
    provider: Provider, 
    autoSelectSource: boolean
  ): string {
    if (!autoSelectSource) {
      // Specific error messages for when auto-select is OFF
      switch (provider) {
        case 'katana':
          return "Katana is currently unavailable. Please try enabling 'Auto-Select Best Source' or choose a different provider.";
        case 'mangadex':
          return "MangaDex is currently unavailable due to DMCA restrictions. Please try enabling 'Auto-Select Best Source' or choose a different provider.";
        case 'mangafire':
          return "MangaFire is currently unavailable. Please try again later or choose a different provider.";
        default:
          return "The selected provider is currently unavailable. Please try enabling 'Auto-Select Best Source' or choose a different provider.";
      }
    } else {
      return "All manga sources are currently unavailable. Please try again later.";
    }
  }
} 