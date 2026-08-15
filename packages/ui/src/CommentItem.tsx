'use client';
import { useState, useRef, useEffect } from 'react';
import { generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import Mention from '@tiptap/extension-mention';
import { formatRelative } from '@deckgauge/shared';
import { ImageLightbox } from './ImageLightbox';

interface CommentData {
  id: string;
  projectId: string;
  content: unknown;
  authorName: string;
  authorAvatar: string | null;
  pinned: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface CommentItemProps {
  comment: CommentData;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}

function renderContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  try {
    // Extension set MUST mirror CommentEditor's (the composer that wrote this
    // JSON). The Color picker stamps text nodes with a `textStyle` mark; without
    // TextStyle/Color registered here, generateHTML throws on the unknown mark
    // and the body renders blank. (underline is covered by StarterKit's default.)
    return generateHTML(content as Record<string, unknown>, [
      StarterKit,
      TextStyle,
      Color,
      Image,
      Mention,
    ]);
  } catch {
    return '';
  }
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function CommentItem({ comment, onEdit, onDelete, onTogglePin }: CommentItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The comment body is injected via dangerouslySetInnerHTML, so its <img>
  // tags can't carry React handlers — delegate the click from the container.
  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      setLightbox({ src: img.currentSrc || img.src, alt: img.alt });
    }
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div className={`px-5 py-4 border-b border-slate-100 ${comment.pinned ? 'bg-amber-500/10' : ''}`}>
      <style>{`.mention { color: #2563eb; font-weight: 500; } .comment-body img { cursor: zoom-in; }`}</style>
      {comment.pinned && (
        <div className="flex items-center gap-1 mb-2">
          <span className="text-xs text-amber-700 font-medium">Pinned</span>
        </div>
      )}
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs font-semibold shrink-0">
          {getInitials(comment.authorName)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">{comment.authorName}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">{formatRelative(comment.createdAt)}</span>
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setShowMenu(!showMenu)}
                  className="text-slate-400 hover:text-slate-600 transition-colors px-1"
                  aria-label="Comment actions"
                >
                  {'\u22EF'}
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-6 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-40">
                    <button
                      type="button"
                      onClick={() => {
                        onTogglePin(comment.id);
                        setShowMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      {comment.pinned ? 'Unpin' : 'Pin to top'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onEdit(comment.id);
                        setShowMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    <div className="border-t border-slate-100 my-1" />
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(comment.id);
                        setShowMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div
            className="comment-body text-sm text-slate-700 mt-1 leading-relaxed prose prose-sm max-w-none"
            onClick={handleContentClick}
            // Safe: content is written only by the local VP, never from untrusted sources
            dangerouslySetInnerHTML={{ __html: renderContent(comment.content) }}
          />
        </div>
      </div>
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
