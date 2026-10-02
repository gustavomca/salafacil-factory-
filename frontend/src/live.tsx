import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
const Context = createContext<((message: string) => void) | null>(null);
export function LiveProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => setMessage(text), []);
  return (
    <Context.Provider value={announce}>
      <div
        className="sr-only"
        role="status"
        aria-label="Atualizações da página"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </div>
      {children}
    </Context.Provider>
  );
}
export function useAnnouncement(
  ref: RefObject<HTMLElement | null>,
  focus = false,
) {
  const announce = useContext(Context);
  const previous = useRef("");
  useEffect(() => {
    const text = ref.current?.textContent ?? "";
    if (text && text !== previous.current) {
      previous.current = text;
      announce?.(text);
      if (focus) ref.current?.focus();
    }
  });
  return Boolean(announce);
}
