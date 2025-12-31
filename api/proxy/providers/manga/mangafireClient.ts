// MangaFire API Client - Raw HTTP layer for new API endpoints
// This client only handles HTTP requests/responses, no business logic

import axios, { AxiosError } from 'axios';
import Constants from 'expo-constants';

/**
 * Get MangaFire API configuration from environment variables
 * Falls back to defaults if not available
 */
function getMangaFireConfig() {
  let apiKey = '';
  let baseUrl = 'https://crysoline.moe';

  try {
    // Try Expo Constants first (for React Native/Expo Go)
    const env = Constants.expoConfig?.extra || {};
    apiKey = env.CRY_API_KEY || '';
    baseUrl = env.CRY_API_BASE || baseUrl;
  } catch (error) {
    console.warn('[MangaFireClient] Failed to load config from Expo Constants:', error);
  }

  // Fallback to process.env for Node.js environments
  if (!apiKey && typeof process !== 'undefined' && process.env) {
    apiKey = process.env.cry_api || process.env.CRY_API_KEY || '';
    baseUrl = process.env.crysoline || process.env.CRY_API_BASE || baseUrl;
  }

  // Remove trailing slash from base URL if present
  baseUrl = baseUrl.replace(/\/$/, '');

  return { apiKey, baseUrl };
}

const { apiKey: MANGAFIRE_API_KEY, baseUrl: MANGAFIRE_API_BASE_URL } = getMangaFireConfig();

// Raw API response types (mirror server response shapes)
export interface MangaFireSearchResultRaw {
  id: string; // e.g., "manga/one-piecee.dkw"
  title: {
    romaji?: string;
    english?: string;
    native?: string;
    japanese?: string;
  };
  image?: {
    small?: string;
    medium?: string;
    large?: string;
    aspectRatio?: number;
  };
  metadata?: {
    status?: string;
    chapter?: string;
    volume?: string;
    imageUrl?: string;
  };
}

export interface MangaFireInfoRaw {
  id: string;
  title: {
    english?: string;
    romaji?: string;
    native?: string;
    japanese?: string;
  };
  synonyms?: string[];
  description?: string;
  metadata?: {
    status?: string;
    type?: string;
    author?: string;
    published?: string;
    genres?: string[];
    mangazines?: string[];
    languages?: string[];
  };
}

export interface MangaFireChapterRaw {
  id: string;
  title: string;
  number: number;
  updatedAt: string;
}

export interface MangaFirePagesRaw {
  pages?: Array<{
    url: string;
    number?: number;
    headers?: Record<string, string>;
  }>;
  isLatestChapter?: boolean;
}

export class MangaFireApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    // Use provided values or fall back to environment/config
    this.baseUrl = baseUrl || MANGAFIRE_API_BASE_URL;
    this.apiKey = apiKey || MANGAFIRE_API_KEY;

    // Validate API key is present
    if (!this.apiKey) {
      console.warn('[MangaFireClient] ⚠️ API key not found! Please set cry_api in .env file');
    } else {
      console.log('[MangaFireClient] ✅ Initialized with API key (length:', this.apiKey.length, ')');
    }
  }

  /**
   * Make authenticated request to MangaFire API
   */
  private async makeRequest<T>(
    endpoint: string,
    options: {
      params?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      console.log(`[MangaFireClient] Requesting: ${url}`, options.params || '');

      const response = await axios.get<T>(url, {
        headers: {
          'x-api-key': this.apiKey,
          'Accept': '*/*',
          'User-Agent': 'Kamilist/1.0',
        },
        params: options.params,
        timeout: options.timeout || 15000,
      });

      console.log(`[MangaFireClient] Response from ${endpoint}:`, 
        JSON.stringify(response.data).substring(0, 200) + '...');
      
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        console.error(`[MangaFireClient] API Error (${endpoint}):`, {
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          data: axiosError.response?.data,
        });

        // Provide more helpful error messages
        if (axiosError.response?.status === 401) {
          throw new Error('Invalid API key');
        } else if (axiosError.response?.status === 404) {
          throw new Error('Resource not found');
        } else if (axiosError.response?.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else if (axiosError.response?.status === 500) {
          throw new Error('Server error. Please try again later.');
        }
      }
      
      throw error;
    }
  }

  /**
   * Search for manga
   * GET /api/manga/mangafire/search?q={query}
   */
  async search(query: string): Promise<MangaFireSearchResultRaw[]> {
    const results = await this.makeRequest<MangaFireSearchResultRaw[]>(
      '/api/manga/mangafire/search',
      {
        params: { q: query },
      }
    );
    
    // API returns array directly
    return Array.isArray(results) ? results : [];
  }

  /**
   * Get manga info
   * GET /api/manga/mangafire/info/{id}
   */
  async getInfo(mangaId: string): Promise<MangaFireInfoRaw> {
    // Normalize ID: remove manga/ prefix if present
    const normalizedId = mangaId.startsWith('manga/') 
      ? mangaId.replace('manga/', '') 
      : mangaId;
    
    return await this.makeRequest<MangaFireInfoRaw>(
      `/api/manga/mangafire/info/${encodeURIComponent(normalizedId)}`
    );
  }

  /**
   * Get manga chapters
   * GET /api/manga/mangafire/chapters/{id}
   */
  async getChapters(mangaId: string): Promise<MangaFireChapterRaw[]> {
    // Normalize ID: remove manga/ prefix if present
    const normalizedId = mangaId.startsWith('manga/') 
      ? mangaId.replace('manga/', '') 
      : mangaId;
    
    const results = await this.makeRequest<MangaFireChapterRaw[]>(
      `/api/manga/mangafire/chapters/${encodeURIComponent(normalizedId)}`
    );
    
    // API returns array directly
    return Array.isArray(results) ? results : [];
  }

  /**
   * Get chapter pages
   * GET /api/manga/mangafire/pages?id={mangaId}&chapterId={chapterId}&lang={lang}
   */
  async getPages(mangaId: string, chapterId: string, lang: string = 'en'): Promise<MangaFirePagesRaw> {
    // Normalize manga ID - remove any prefixes if present
    let normalizedMangaId = mangaId;
    if (normalizedMangaId.includes('manga/')) {
      normalizedMangaId = normalizedMangaId.replace('manga/', '');
    }
    
    // Normalize chapter ID
    let normalizedChapterId = chapterId;
    if (normalizedChapterId.includes('manga/')) {
      normalizedChapterId = normalizedChapterId.replace('manga/', '');
    }
    
    // API returns an array directly: [{url, index, headers}, ...]
    const result = await this.makeRequest<any>(
      `/api/manga/mangafire/pages`,
      {
        params: {
          id: normalizedMangaId,
          chapterId: normalizedChapterId,
          lang: lang
        }
      }
    );
    
    // CRITICAL: The API returns an ARRAY directly, not { pages: [...] }
    console.log(`[MangaFireClient] 🔍 getPages() received result:`, {
      isArray: Array.isArray(result),
      type: typeof result,
      length: Array.isArray(result) ? result.length : 'N/A',
      hasPages: !!(result as any)?.pages,
      keys: !Array.isArray(result) && result ? Object.keys(result) : 'N/A'
    });
    
    // Extract pages array - handle both direct array and wrapped formats
    let pagesArray: any[] = [];
    if (Array.isArray(result)) {
      // Most common case: API returns array directly
      pagesArray = result;
      console.log(`[MangaFireClient] ✅ Using direct array (${pagesArray.length} items)`);
    } else if (result && Array.isArray((result as any).pages)) {
      // Wrapped format: { pages: [...] }
      pagesArray = (result as any).pages;
      console.log(`[MangaFireClient] ✅ Using wrapped pages array (${pagesArray.length} items)`);
    } else if (result && Array.isArray((result as any).data)) {
      // Alternative wrapped format: { data: [...] }
      pagesArray = (result as any).data;
      console.log(`[MangaFireClient] ✅ Using wrapped data array (${pagesArray.length} items)`);
    } else {
      console.error(`[MangaFireClient] ❌ UNEXPECTED FORMAT - result:`, JSON.stringify(result).substring(0, 500));
      return {
        pages: [],
        isLatestChapter: false
      };
    }
    
    if (pagesArray.length === 0) {
      console.warn(`[MangaFireClient] ⚠️ Pages array is empty`);
      return {
        pages: [],
        isLatestChapter: false
      };
    }
    
    // Transform to expected format: map index to number, preserve url and headers
    const pages = pagesArray
      .map((page: any, idx: number) => {
        const url = page.url || page.imageUrl || page.src || '';
        if (!url) {
          console.warn(`[MangaFireClient] ⚠️ Page at index ${idx} has no URL:`, page);
          return null;
        }
        return {
          url: url,
          number: page.number || (page.index !== undefined ? page.index + 1 : idx + 1),
          headers: page.headers || {}
        };
      })
      .filter((p: any) => p !== null); // Remove null entries
    
    console.log(`[MangaFireClient] ✅ Successfully converted ${pages.length} pages`);
    
    // Return in expected format
    return {
      pages: pages,
      isLatestChapter: false
    };
  }
}

// Export singleton instance
export const mangafireApiClient = new MangaFireApiClient();

