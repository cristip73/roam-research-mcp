import Bottleneck from 'bottleneck';

export const globalLimiter = new Bottleneck({
  reservoir: 300,
  reservoirRefreshAmount: 300,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 1
});

export function createToolLimiter(options: Bottleneck.ConstructorOptions = {}): Bottleneck {
  const limiter = new Bottleneck(options);
  limiter.chain(globalLimiter);
  return limiter;
}
