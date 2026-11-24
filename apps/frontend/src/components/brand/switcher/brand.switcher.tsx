'use client';

// Brand switcher: the Ctrl+K (Cmd+K) palette that lists the user's brands and moves to one
// with a full page load, so nothing of the old brand stays in memory.
// It saves the choice as the default first and lands in the same section of the new brand.
import React, {
  FC,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import {
  splitWorkspacePath,
  workspacePath,
} from '@gitroom/helpers/utils/workspace.path';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useWorkspaceId } from '@gitroom/frontend/components/layout/workspace.navigation';
import { NewBrandDialog } from '@gitroom/frontend/components/brand/profile/new.brand.dialog';
import { BrandAvatar } from '@gitroom/frontend/components/brand/switcher/brand.avatar';
import { useSwitcherBrands } from '@gitroom/frontend/components/brand/switcher/use.switcher.brands';

// Fields where Ctrl+K belongs to the editor's own link shortcut.
const EDITOR_FIELD = '[contenteditable="true"], [contenteditable=""], .ProseMirror';

// Whether a key press is the palette shortcut and is not meant for the editor field it came from.
const isPaletteShortcut = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.altKey || event.shiftKey) {
    return false;
  }
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') {
    return false;
  }
  const target = event.target as Element | null;
  return !target?.closest?.(EDITOR_FIELD);
};

// The top-level sections a switch keeps; anything else lands on the calendar.
const SECTION_ROOTS = [
  '/launches',
  '/analytics',
  '/media',
  '/plugs',
  '/agents',
  '/third-party',
  '/settings',
  '/billing',
  '/ai-captions',
  '/quick-start',
  '/super-admin',
];

// Where a switch to `id` lands: the root of the section this tab is in, never the query, the hash or an item id.
const targetPath = (id: string) => {
  const { path } = splitWorkspacePath(window.location.pathname);
  const root = SECTION_ROOTS.find(
    (section) => path === section || path.startsWith(`${section}/`)
  );
  return workspacePath(root ?? '/launches', id);
};

// The palette: opens on Ctrl+K or from the badge (the caller owns `isOpen`), filters the brands as the user
// types and switches with a page load.
export const BrandSwitcher: FC<{
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}> = ({ isOpen: open, onOpen, onClose: close }) => {
  const t = useT();
  const fetch = useFetch();
  const modals = useModals();
  const currentId = useWorkspaceId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [switchingId, setSwitchingId] = useState('');
  const { data, error, isLoading } = useSwitcherBrands(open);
  const prefetched = useRef(new Set<string>());
  // Set at the first choice, before the next render, so a second click or Enter in the same moment is ignored.
  const switching = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  // The brands matching what was typed, by name or slug.
  const brands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data ?? []).filter(
      (brand) =>
        !needle ||
        brand.name.toLowerCase().includes(needle) ||
        brand.slug.toLowerCase().includes(needle)
    );
  }, [data, query]);
  // The "New brand" entry comes after the last brand, so it takes the index `brands.length`.
  const count = brands.length + 1;

  // Toggles the palette from the shortcut and keeps the browser's own Ctrl+K from firing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) {
        return;
      }
      event.preventDefault();
      if (open) {
        close();
      } else {
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpen, close]);

  // Starts every opening with an empty filter and the first entry highlighted.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Keeps the highlight on an entry that exists after the filter changed.
  useEffect(() => {
    setActive((value) => Math.min(value, count - 1));
  }, [count]);

  // Asks the browser for the page of the highlighted brand so choosing it loads sooner.
  useEffect(() => {
    const brand = brands[active];
    if (!open || !brand || brand.id === currentId) {
      return;
    }
    if (prefetched.current.has(brand.id)) {
      return;
    }
    prefetched.current.add(brand.id);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'document';
    link.href = targetPath(brand.id);
    document.head.appendChild(link);
  }, [open, active, brands, currentId]);

  // Scrolls the highlighted entry into view while the arrow keys move through a long list.
  useEffect(() => {
    list.current
      ?.querySelectorAll('[role="option"]')
      [active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  // Saves the brand as the default for new tabs, then moves to the same section of it with a full page load;
  // the current brand only closes the palette, and a second choice while switching is ignored.
  const choose = useCallback(
    async (id: string) => {
      if (id === currentId) {
        close();
        return;
      }
      if (switching.current) {
        return;
      }
      switching.current = true;
      setSwitchingId(id);
      try {
        await fetch('/user/change-org', {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
      } catch {
        // The default is only a convenience: the switch still happens
      }
      window.location.assign(targetPath(id));
    },
    [currentId, close, fetch]
  );

  // Opens the "New brand" dialog in place of the palette.
  const createBrand = useCallback(() => {
    if (switching.current) {
      return;
    }
    close();
    modals.openModal({
      title: t('new_brand', 'New brand'),
      children: (done) => <NewBrandDialog onClose={done} />,
    });
  }, [close, modals, t]);

  // Runs the highlighted entry: a brand to switch to, or the "New brand" entry.
  const run = useCallback(
    (index: number) => {
      const brand = brands[index];
      if (brand) {
        choose(brand.id);
        return;
      }
      createBrand();
    },
    [brands, choose, createBrand]
  );

  // Arrow keys move the highlight, Enter runs it and Escape closes the palette.
  const onInputKey = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((value) => (value + 1) % count);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((value) => (value - 1 + count) % count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        run(active);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [active, count, run, close]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      style={{ zIndex: 300 }}
      className="fixed left-0 top-0 w-full h-full bg-popup flex items-start justify-center pt-[15vh] text-newTextColor animate-fadeIn"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label={t('switch_brand', 'Switch brand')}
        className="bg-newBgColorInner rounded-[16px] w-[480px] max-w-[90vw] flex flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKey}
          placeholder={t('search_brands', 'Search brands…')}
          aria-label={t('search_brands', 'Search brands…')}
          className="bg-transparent outline-none w-full p-[16px] border-b border-newTableBorder"
        />
        <div ref={list} role="listbox" className="max-h-[360px] overflow-y-auto">
          {isLoading && (
            <div className="px-[16px] py-[10px] text-textItemBlur">
              {t('loading', 'Loading…')}
            </div>
          )}
          {!isLoading && !!error && (
            <div className="px-[16px] py-[10px] text-red-400">
              {t('brands_load_failed', 'Failed to load your brands')}
            </div>
          )}
          {brands.map((brand, index) => (
            <div
              key={brand.id}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(brand.id)}
              className={clsx(
                'flex items-center gap-[10px] px-[16px] py-[10px] cursor-pointer',
                index === active && 'bg-boxHover'
              )}
            >
              <BrandAvatar
                name={brand.name}
                color={brand.color}
                avatarUrl={brand.avatarUrl}
              />
              <div className="flex-1 truncate">{brand.name}</div>
              {brand.id === currentId && (
                <div className="text-[12px] text-textItemBlur">
                  {t('current_brand', 'Current')}
                </div>
              )}
              {brand.id === switchingId && (
                <div className="text-[12px] text-textItemBlur">
                  {t('switching_brand', 'Switching…')}
                </div>
              )}
            </div>
          ))}
          <div
            role="option"
            aria-selected={active === brands.length}
            onMouseEnter={() => setActive(brands.length)}
            onClick={createBrand}
            className={clsx(
              'flex items-center gap-[10px] px-[16px] py-[10px] cursor-pointer border-t border-newTableBorder',
              active === brands.length && 'bg-boxHover'
            )}
          >
            <div className="w-[28px] h-[28px] shrink-0 flex items-center justify-center rounded-full bg-btnSimple">
              +
            </div>
            <div className="flex-1">{t('new_brand', 'New brand')}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
