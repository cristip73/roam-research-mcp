import Bottleneck from 'bottleneck';

export const globalLimiter = new Bottleneck({
  reservoir: 240,
  reservoirRefreshAmount: 240,
  reservoirRefreshInterval: 60 * 1000,
  minTime: 150,
  maxConcurrent: 1
});

export function createToolLimiter(options: Bottleneck.ConstructorOptions = {}): Bottleneck {
  const limiter = new Bottleneck(options);
  limiter.chain(globalLimiter);
  return limiter;
}
