import type { Graph, BatchAction } from '@roam-research/roam-api-sdk';
import {
  q as apiQ,
  createPage as apiCreatePage,
  createBlock as apiCreateBlock,
  updateBlock as apiUpdateBlock,
  batchActions as apiBatchActions
} from '@roam-research/roam-api-sdk';
import type Bottleneck from 'bottleneck';
import { globalLimiter } from './rate-limiter.js';

function schedule<T>(limiter: Bottleneck | null, fn: () => Promise<T>): Promise<T> {
  const l = limiter ?? globalLimiter;
  return l.schedule(fn);
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

export function batchActions(graph: Graph, params: { action: 'batch-actions'; actions: BatchAction[] }, limiter?: Bottleneck) {
  return schedule(limiter ?? null, () => apiBatchActions(graph, params));
}
