import type { Graph, RoamBatchActions } from '@roam-research/roam-api-sdk';
import {
  q as apiQ,
  createPage as apiCreatePage,
  createBlock as apiCreateBlock,
  updateBlock as apiUpdateBlock,
  batchActions as apiBatchActions
} from '@roam-research/roam-api-sdk';
import type Bottleneck from 'bottleneck';
import { globalLimiter } from './rate-limiter.js';

// Maximum retry attempts for rate limit errors
const MAX_RETRIES = 5;
// Base delay in ms (exponential backoff will multiply this)
const BASE_RETRY_DELAY = 2000;

/**
 * Schedule function execution with the bottleneck limiter,
 * with automatic retry for rate limit errors
 */
async function schedule<T>(limiter: Bottleneck | null, fn: () => Promise<T>): Promise<T> {
  const l = limiter ?? globalLimiter;
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await l.schedule(fn);
    } catch (error) {
      lastError = error as Error;
      
      // Check if it's a rate limit error
      if (error instanceof Error && 
          (error.message.includes('Too many requests') || 
           error.message.includes('rate limit'))) {
        // Calculate delay with exponential backoff
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
        console.warn(`Rate limit hit, retrying after ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        // Continue to next retry attempt
      } else {
        // For any other error, throw immediately
        throw error;
      }
    }
  }
  
  // If we've exhausted all retries
  throw lastError || new Error('Failed after maximum retry attempts');
}

export function q(graph: Graph, query: string, params: unknown[], limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiQ(graph, query, params));
}

export function createPage(graph: Graph, params: any, limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiCreatePage(graph, params));
}

export function createBlock(graph: Graph, params: any, limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiCreateBlock(graph, params));
}

export function updateBlock(graph: Graph, params: any, limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiUpdateBlock(graph, params));
}

export function batchActions(graph: Graph, params: RoamBatchActions, limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiBatchActions(graph, params));
}
