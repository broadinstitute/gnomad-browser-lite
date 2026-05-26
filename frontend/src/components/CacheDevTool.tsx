import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { cacheDevBus, type CacheLayer, type CacheLogEntry, type CacheStateUpdate } from '../api/client';

const MAX_LOG_ENTRIES = 50;

const LAYER_COLORS: Record<CacheLayer, string> = {
  frontend: '#22c55e',
  moka: '#3b82f6',
  miss: '#9ca3af',
  prefetch: '#a855f7',
};

const LAYER_LABELS: Record<CacheLayer, string> = {
  frontend: 'FE Cache',
  moka: 'Moka Hit',
  miss: 'Miss',
  prefetch: 'Prefetch',
};

const Panel = styled.div<{ $minimized: boolean }>`
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 99999;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  background: #1a1a2e;
  color: #e0e0e0;
  border: 1px solid #333;
  border-radius: 6px;
  width: ${p => p.$minimized ? 'auto' : '380px'};
  max-height: ${p => p.$minimized ? 'auto' : '400px'};
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: #16213e;
  border-bottom: 1px solid #333;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  user-select: none;
`;

const Title = styled.span`
  font-weight: 600;
  color: #a0a0c0;
`;

const Stats = styled.div`
  padding: 6px 10px;
  display: flex;
  gap: 12px;
  border-bottom: 1px solid #2a2a3e;
  flex-wrap: wrap;
`;

const Stat = styled.span`
  color: #888;
  & strong { color: #ccc; }
`;

const LogContainer = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  min-height: 0;
`;

const LogEntry = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  &:hover { background: #222240; }
`;

const LayerBadge = styled.span<{ $color: string }>`
  background: ${p => p.$color}22;
  color: ${p => p.$color};
  border: 1px solid ${p => p.$color}44;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  white-space: nowrap;
  min-width: 62px;
  text-align: center;
`;

const Url = styled.span`
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
`;

const Duration = styled.span`
  color: #666;
  white-space: nowrap;
`;

const MinButton = styled.span`
  color: #888;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  &:hover { color: #fff; }
`;

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.replace('frontend-cache://', '');
  }
}

export function CacheDevTool() {
  const [visible, setVisible] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [logs, setLogs] = useState<CacheLogEntry[]>([]);
  const [cacheState, setCacheState] = useState<CacheStateUpdate>({ intervalCount: 0, variantCount: 0 });
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((entry: CacheLogEntry) => {
    setLogs(prev => {
      const next = [entry, ...prev];
      return next.length > MAX_LOG_ENTRIES ? next.slice(0, MAX_LOG_ENTRIES) : next;
    });
  }, []);

  useEffect(() => {
    const offLog = cacheDevBus.on('cache-log', addLog);
    const offState = cacheDevBus.on('cache-state', setCacheState);
    return () => { offLog(); offState(); };
  }, [addLog]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '~') {
        setVisible(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!visible) return null;

  if (minimized) {
    return (
      <Panel $minimized>
        <Header onClick={() => setMinimized(false)}>
          <Title>Cache</Title>
          <MinButton onClick={e => { e.stopPropagation(); setVisible(false); }}>x</MinButton>
        </Header>
      </Panel>
    );
  }

  const counts = logs.reduce((acc, l) => {
    acc[l.layer] = (acc[l.layer] || 0) + 1;
    return acc;
  }, {} as Partial<Record<CacheLayer, number>>);

  return (
    <Panel $minimized={false}>
      <Header onClick={() => setMinimized(true)}>
        <Title>Cache DevTool</Title>
        <div style={{ display: 'flex', gap: 8 }}>
          <MinButton onClick={e => { e.stopPropagation(); setMinimized(true); }}>-</MinButton>
          <MinButton onClick={e => { e.stopPropagation(); setVisible(false); }}>x</MinButton>
        </div>
      </Header>
      <Stats>
        <Stat>Intervals: <strong>{cacheState.intervalCount}</strong></Stat>
        <Stat>Variants: <strong>{cacheState.variantCount.toLocaleString()}</strong></Stat>
        {(Object.entries(counts) as [CacheLayer, number][]).map(([layer, count]) => (
          <Stat key={layer}>
            <span style={{ color: LAYER_COLORS[layer] }}>{LAYER_LABELS[layer]}</span>: <strong>{count}</strong>
          </Stat>
        ))}
      </Stats>
      <LogContainer ref={logRef}>
        {logs.map((entry, i) => (
          <LogEntry key={i}>
            <LayerBadge $color={LAYER_COLORS[entry.layer]}>
              {LAYER_LABELS[entry.layer]}
            </LayerBadge>
            <Url title={entry.url}>{formatUrl(entry.url)}</Url>
            {entry.duration > 0 && (
              <Duration>{entry.duration < 1000 ? `${Math.round(entry.duration)}ms` : `${(entry.duration / 1000).toFixed(1)}s`}</Duration>
            )}
          </LogEntry>
        ))}
        {logs.length === 0 && (
          <div style={{ padding: '16px 10px', color: '#555', textAlign: 'center' }}>
            No API calls yet. Browse to see cache activity.
          </div>
        )}
      </LogContainer>
    </Panel>
  );
}
