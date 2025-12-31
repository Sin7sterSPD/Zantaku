// MangaFire Provider - Refactored to use new API (crysoline.moe)
// Maintains existing contract for compatibility with MangaProviderService

import { Chapter } from './index';
import { 
  mangafireApiClient, 
  MangaFireSearchResultRaw, 
  MangaFireInfoRaw, 
  MangaFireChapterRaw 
} from './mangafireClient';

// Provider contract interfaces (what TSX components consume)
interface MangaFireSearchResult {
  id: string;
  title: string;
  altTitles: string[];
  description: string;
  coverImage: string;
  status: string;
  type: string;
  genres: string[];
  authors: string[];
  rating: number;
  views: number;
  lastUpdated: string;
}

interface MangaFirePage {
  url: string;
  number: number;
  headers?: Record<string, string>;
}

interface MangaFireChapterResponse {
  pages: MangaFirePage[];
  isLatestChapter: boolean;
}

export class MangaFireProvider {
  /**
   * Normalize manga ID to canonical format (without manga/ prefix)
   * Canonical format: "one-piecee.dkw" (no prefix)
   */
  private normalizeMangaId(rawId: string): string {
    if (rawId.startsWith('manga/')) {
      return rawId.replace('manga/', '');
    }
    return rawId;
  }

  /**
   * Convert canonical manga ID to API format if needed
   * Currently API accepts IDs without prefix, so this is a pass-through
   */
  private toCanonicalMangaId(mangaId: string): string {
    return this.normalizeMangaId(mangaId);
  }

  /**
   * Extract title string from title object (prefer english > romaji > native > japanese)
   */
  private extractTitleString(title: MangaFireSearchResultRaw['title'] | MangaFireInfoRaw['title']): string {
    if (typeof title === 'string') {
      return title;
    }
    if (!title) {
      return '';
    }
    return title.english || title.romaji || title.native || title.japanese || '';
  }

  /**
   * Map raw search result to provider contract
   */
  private mapSearchResult(raw: MangaFireSearchResultRaw): MangaFireSearchResult {
    const normalizedId = this.normalizeMangaId(raw.id);
    const titleString = this.extractTitleString(raw.title);
    
    return {
      id: normalizedId,
      title: titleString,
      altTitles: [],
      description: '',
      coverImage: raw.image?.large || raw.image?.medium || raw.image?.small || raw.metadata?.imageUrl || '',
      status: raw.metadata?.status || '',
      type: 'Manga',
      genres: [],
      authors: [],
      rating: 0,
      views: 0,
      lastUpdated: ''
    };
  }

  /**
   * Map raw info result to provider contract
   */
  private mapInfoResult(raw: MangaFireInfoRaw, mangaId: string): MangaFireSearchResult {
    const normalizedId = this.normalizeMangaId(mangaId);
    const titleString = this.extractTitleString(raw.title);
    
    // Note: Info endpoint may not return image data, so we leave it empty
    // The coverImage should come from search results or be passed separately
    return {
      id: normalizedId,
      title: titleString,
      altTitles: raw.synonyms || [],
      description: raw.description || '',
      coverImage: '', // Info endpoint doesn't return image data
      status: raw.metadata?.status || '',
      type: raw.metadata?.type || 'Manga',
      genres: raw.metadata?.genres || [],
      authors: raw.metadata?.author ? [raw.metadata.author] : [],
      rating: 0,
      views: 0,
      lastUpdated: raw.metadata?.published || ''
    };
  }

  /**
   * Map raw chapter to provider contract
   */
  private mapChapter(raw: MangaFireChapterRaw, index: number): Chapter {
    return {
      id: raw.id,
      number: raw.number.toString(),
      title: raw.title || `Chapter ${raw.number}`,
      url: raw.id,
      updatedAt: raw.updatedAt,
      scanlationGroup: '',
      pages: 0,
      translatedLanguage: 'en',
      source: 'mangafire',
      isLatest: index === 0 // Assume first chapter is latest (API may provide flag later)
    };
  }

  // Helper function to normalize titles for better matching (kept for compatibility)
  private normalizeTitle(title: string): string {
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
      .toLowerCase()
      .replace(/[:\-\s]+/g, ' ') // Normalize separators
      .trim();
  }

  // Helper function to calculate title similarity score
  private calculateSimilarityScore(searchTitle: string, resultTitle: string): number {
    const normalizedSearch = this.normalizeTitle(searchTitle);
    const normalizedResult = this.normalizeTitle(resultTitle);
    
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
    const japaneseMappings = {
      '地雷': ['landmine', 'dangerous', 'jirai'],
      '地原': ['chihara'],
      'なんですか': ['desu ka', 'what is', 'is it'],
      'jirai': ['地雷', 'landmine', 'dangerous'],
      'chihara': ['地原']
    };
    
    // Check for Japanese-English mappings
    for (const [japanese, english] of Object.entries(japaneseMappings)) {
      if (normalizedSearch.includes(japanese) || english.some(e => normalizedSearch.includes(e))) {
        if (normalizedResult.includes(japanese) || english.some(e => normalizedResult.includes(e))) {
          // High score for matching Japanese-English pairs
          return 80;
        }
      }
    }
    
    // Split into words and calculate word overlap
    const searchWords = normalizedSearch.split(/\s+/).filter(word => word.length > 2);
    const resultWords = normalizedResult.split(/\s+/).filter(word => word.length > 2);
    
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
    let japaneseBonus = 0;
    if (this.containsJapanese(searchTitle) && !this.containsJapanese(resultTitle)) {
      // Bonus for finding English equivalent of Japanese title
      japaneseBonus = 15;
    }
    
    return Math.min(100, wordMatchPercentage + positionBonus + lengthBonus + japaneseBonus);
  }

  async search(query: string, page: number = 1): Promise<MangaFireSearchResult[]> {
    console.log(`[MangaFire] Searching for: "${query}" (page ${page})`);
    
    try {
      // Use new API client
      const rawResults = await mangafireApiClient.search(query);
      
      console.log(`[MangaFire] Search results count: ${rawResults.length}`);
      
      if (rawResults.length === 0) {
        return [];
      }
      
      // Map to provider contract
      const mappedResults = rawResults.map(raw => this.mapSearchResult(raw));
      
      // Sort by relevance score (using existing logic for compatibility)
      const scoredResults = mappedResults.map((result) => {
        const score = this.calculateSimilarityScore(query, result.title);
        return {
          ...result,
          relevanceScore: score
        };
      }).sort((a: any, b: any) => b.relevanceScore - a.relevanceScore);
      
      // Log top 3 results
      console.log(`[MangaFire] Top 3 results by relevance:`);
      scoredResults.slice(0, 3).forEach((result: any, index: number) => {
        console.log(`[MangaFire] ${index + 1}. "${result.title}" - Score: ${result.relevanceScore}`);
      });
      
      // Remove relevanceScore before returning (not part of contract)
      return scoredResults.map(({ relevanceScore, ...result }) => result);
      
    } catch (error) {
      console.error('[MangaFire] Search failed:', error);
      throw error;
    }
  }

  // Helper function to detect Japanese characters
  private containsJapanese(text: string): boolean {
    return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  }


  async getMangaDetails(id: string): Promise<MangaFireSearchResult> {
    console.log(`[MangaFire] Getting manga details for ID: ${id}`);
    
    try {
      // Normalize ID before making request
      const normalizedId = this.toCanonicalMangaId(id);
      
      // Use new API client
      const rawInfo = await mangafireApiClient.getInfo(normalizedId);
      console.log(`[MangaFire] Manga details received for ${normalizedId}`);
      
      // Map to provider contract
      return this.mapInfoResult(rawInfo, normalizedId);
      
    } catch (error) {
      console.error('[MangaFire] Failed to get manga details:', error);
      throw error;
    }
  }

  async getChapters(mangaId: string, options?: { offset?: number, limit?: number, includePages?: boolean }): Promise<Chapter[]> {
    console.log(`[MangaFire] Getting chapters for manga ID: ${mangaId}`, options ? `with options: ${JSON.stringify(options)}` : '');
    
    try {
      // Normalize ID before making request
      const normalizedId = this.toCanonicalMangaId(mangaId);
      
      // Use new API client
      const rawChapters = await mangafireApiClient.getChapters(normalizedId);
      console.log(`[MangaFire] Received ${rawChapters.length} chapters for ${normalizedId}`);
      
      if (rawChapters.length === 0) {
        return [];
      }
      
      // Sort chapters by number (descending - newest first)
      const sortedChapters = [...rawChapters].sort((a, b) => b.number - a.number);
      
      // Apply pagination if needed
      const offset = options?.offset || 0;
      const limit = options?.limit || 9999;
      const paginatedChapters = sortedChapters.slice(offset, offset + limit);
      
      console.log(`[MangaFire] Returning ${paginatedChapters.length} chapters (${offset} to ${offset + paginatedChapters.length - 1})`);
      
      // Map to provider contract
      return paginatedChapters.map((raw, index) => {
        const chapter = this.mapChapter(raw, index);
        // Set isLatest only for first chapter if this is first page
        chapter.isLatest = offset === 0 && index === 0;
        return chapter;
      });
      
    } catch (error) {
      console.error('[MangaFire] Failed to get chapters:', error);
      throw error;
    }
  }

  async getChapterPages(chapterId: string, mangaId?: string): Promise<MangaFireChapterResponse> {
    console.log(`[MangaFire] Getting pages for chapter ID: ${chapterId}, manga ID: ${mangaId || 'not provided'}`);
    
    if (!mangaId) {
      throw new Error('Manga ID is required for MangaFire pages endpoint');
    }
    
    try {
      // Use new API client with query parameters
      const rawPages = await mangafireApiClient.getPages(mangaId, chapterId);
      
      console.log(`[MangaFire] 🔍 getChapterPages() received rawPages:`, {
        type: typeof rawPages,
        isArray: Array.isArray(rawPages),
        hasPages: !!(rawPages as any)?.pages,
        pagesLength: (rawPages as any)?.pages?.length || 0,
        keys: rawPages ? Object.keys(rawPages) : 'null/undefined',
        rawPagesString: JSON.stringify(rawPages).substring(0, 300)
      });
      
      // The client should return { pages: [...], isLatestChapter: false }
      // But handle edge cases where it might return array directly
      let pagesArray: any[] = [];
      if (rawPages && Array.isArray((rawPages as any).pages)) {
        pagesArray = (rawPages as any).pages;
        console.log(`[MangaFire] ✅ Using rawPages.pages (${pagesArray.length} items)`);
      } else if (Array.isArray(rawPages)) {
        // Fallback: if client returned array directly
        pagesArray = rawPages;
        console.log(`[MangaFire] ✅ Using rawPages as direct array (${pagesArray.length} items)`);
      } else {
        console.error(`[MangaFire] ❌ Invalid rawPages format:`, rawPages);
        return { pages: [], isLatestChapter: false };
      }
      
      if (pagesArray.length === 0) {
        console.warn('[MangaFire] ⚠️ No pages returned from API - pagesArray is empty');
        console.warn('[MangaFire] ⚠️ rawPages object:', JSON.stringify(rawPages).substring(0, 500));
        return { pages: [], isLatestChapter: false };
      }
      
      // Map to provider contract - ensure all required fields
      const pages: MangaFirePage[] = pagesArray.map((page: any, index: number) => {
        if (!page.url) {
          console.warn(`[MangaFire] ⚠️ Page at index ${index} missing URL:`, page);
          return null;
        }
        return {
          url: page.url,
          number: page.number || index + 1,
          headers: page.headers || { 'Referer': 'https://mangafire.to' }
        };
      }).filter((p: any) => p !== null) as MangaFirePage[];
      
      console.log(`[MangaFire] ✅ Successfully loaded ${pages.length} pages`);
      
      return {
        pages,
        isLatestChapter: (rawPages as any)?.isLatestChapter || false
      };
      
    } catch (error: any) {
      // If pages endpoint is not implemented, return empty
      if (error.message?.includes('not yet implemented')) {
        console.warn('[MangaFire] Pages endpoint not yet implemented');
        return { pages: [], isLatestChapter: false };
      }
      
      console.error('[MangaFire] Failed to get chapter pages:', error);
      throw error;
    }
  }

  async advancedSearch(params: {
    type?: string;
    status?: string;
    genres?: string[];
    excludedGenres?: string[];
    sort?: string;
    page?: number;
  }): Promise<MangaFireSearchResult[]> {
    console.log(`[MangaFire] Advanced search with params:`, params);
    
    // Advanced search isn't fully supported in this API, so we'll do a regular search
    // Use type as search term if provided, otherwise use a generic query
    const searchTerm = params.type || 'manga';
    
    try {
      const rawResults = await mangafireApiClient.search(searchTerm);
      
      // Filter by status if provided
      let filteredResults = rawResults;
      if (params.status) {
        filteredResults = filteredResults.filter(r => 
          r.metadata?.status?.toLowerCase() === params.status?.toLowerCase()
        );
      }
      
      // Map to provider contract
      return filteredResults.map(raw => this.mapSearchResult(raw));
      
    } catch (error) {
      console.error('[MangaFire] Advanced search failed:', error);
      return [];
    }
  }
}

export default new MangaFireProvider(); 