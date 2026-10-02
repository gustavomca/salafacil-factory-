import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { request } from "./api";
import { clockSnapshot, subscribeClock } from "./time";
export function useQuery<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    request<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, reload, setData };
}
export function useTick(milliseconds = 30000) {
  // Recheck the clock snapshot if it changes between render and subscription.
  const clock = useSyncExternalStore(
    subscribeClock,
    clockSnapshot,
    clockSnapshot,
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), milliseconds);
    return () => clearInterval(id);
  }, [milliseconds]);
  return tick + clock;
}
