import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
interface DraftStore {
  values: Map<string, unknown>;
  clear: (prefix: string) => void;
}
const Context = createContext<DraftStore | null>(null);
/** This provider is keyed by the authenticated owner above Protected. No browser storage. */
export function DraftProvider({
  children,
  reset = 0,
}: {
  children: ReactNode;
  reset?: number;
}) {
  const store = useRef<DraftStore | null>(null);
  if (!store.current) {
    const values = new Map<string, unknown>();
    store.current = {
      values,
      clear: (prefix) => {
        for (const key of values.keys())
          if (key.startsWith(prefix)) values.delete(key);
      },
    };
  }
  useEffect(() => {
    if (reset) store.current?.clear("");
  }, [reset]);
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}
export function useDraftState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(Context);
  const [value, setValue] = useState<T>(() =>
    store?.values.has(key)
      ? (store.values.get(key) as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial,
  );
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    // Retain committed defaults too, including dates suggested for a direct URL.
    if (store && !store.values.has(key)) store.values.set(key, current.current);
  }, [key, store]);
  const update: Dispatch<SetStateAction<T>> = (next) => {
    const resolved =
      typeof next === "function"
        ? (next as (previous: T) => T)(current.current)
        : next;
    current.current = resolved;
    store?.values.set(key, resolved);
    setValue(resolved);
  };
  return [value, update];
}
export function useClearDraft() {
  const store = useContext(Context);
  return (prefix: string) => store?.clear(prefix);
}
