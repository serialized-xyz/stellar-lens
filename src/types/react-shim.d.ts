// Minimal type declarations for the parts of React 19 this app uses.
// @types/react is not installed (not in the approved dependency list), so
// this file types the hooks, the root API and JSX. Swapping in @types/react
// later only requires deleting this file.

declare module 'react' {
  export type Key = string | number | bigint;
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | null;
  }
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface RefObject<T> {
    current: T;
  }
  export type CSSProperties = Record<string, string | number | undefined>;
  export type FC<P = object> = (props: P) => ReactNode;
  export interface PropsWithChildren {
    children?: ReactNode;
  }

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): RefObject<T>;
  export function useId(): string;
  export const Fragment: (props: { children?: ReactNode }) => ReactElement;
  export const StrictMode: (props: { children?: ReactNode }) => ReactElement;
}

declare module 'react/jsx-runtime' {
  import type { Key, ReactElement, ReactNode, CSSProperties, RefObject } from 'react';
  export function jsx(type: unknown, props: unknown, key?: Key): ReactElement;
  export function jsxs(type: unknown, props: unknown, key?: Key): ReactElement;
  export const Fragment: unknown;

  interface DomEvent<T extends EventTarget = HTMLElement> {
    target: EventTarget & T;
    currentTarget: EventTarget & T;
    preventDefault(): void;
    stopPropagation(): void;
  }
  interface KeyEvent<T extends EventTarget = HTMLElement> extends DomEvent<T> {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }
  interface HtmlProps {
    children?: ReactNode;
    key?: Key | null;
    ref?: RefObject<HTMLElement | null> | RefObject<HTMLInputElement | null> | ((el: HTMLElement | null) => void);
    className?: string;
    id?: string;
    style?: CSSProperties;
    title?: string;
    role?: string;
    tabIndex?: number;
    hidden?: boolean;
    onClick?: (e: DomEvent) => void;
    onKeyDown?: (e: KeyEvent) => void;
    onChange?: (e: DomEvent<HTMLInputElement>) => void;
    onInput?: (e: DomEvent<HTMLInputElement>) => void;
    onSubmit?: (e: DomEvent<HTMLFormElement>) => void;
    onFocus?: (e: DomEvent) => void;
    onBlur?: (e: DomEvent) => void;
    onMouseEnter?: (e: DomEvent) => void;
    onMouseLeave?: (e: DomEvent) => void;
    dangerouslySetInnerHTML?: { __html: string };
    [attr: string]: unknown;
  }

  export namespace JSX {
    type Element = ReactElement;
    type ElementType = string | ((props: never) => ReactNode);
    interface ElementChildrenAttribute {
      children: object;
    }
    interface IntrinsicAttributes {
      key?: Key | null;
    }
    interface IntrinsicElements {
      [tag: string]: HtmlProps;
    }
  }
}

declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export interface Root {
    render(node: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment): Root;
}
