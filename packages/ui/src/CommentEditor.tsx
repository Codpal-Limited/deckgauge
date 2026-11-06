'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import Mention from '@tiptap/extension-mention';
import {
  ImageUploadExtension,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from './extensions/ImageUploadExtension';
import { buildMentionSuggestion } from './extensions/MentionSuggestion';

type TiptapJSON = Record<string, unknown>;

/**
 * Schemes a comment link may carry. Checked BEFORE either insert path: the
 * caret path uses insertContent, which bypasses Link's own isAllowedUri check,
 * and would otherwise store e.g. a `javascript:` href in the comment JSON.
 */
const ALLOWED_LINK = /^(https?:\/\/|mailto:|tel:)/i;

interface CommentEditorProps {
  onSubmit: (content: TiptapJSON) => void;
  projectId?: string;
  orgEmployeeId?: string;
  boardId: string;
  apiBaseUrl: string;
  onUploadIdsChange: (ids: string[]) => void;
  initialContent?: TiptapJSON;
  onCancel?: () => void;
}

export function CommentEditor({
  onSubmit,
  projectId,
  orgEmployeeId,
  boardId,
  apiBaseUrl,
  onUploadIdsChange,
  initialContent,
  onCancel,
}: CommentEditorProps) {
  const isEditMode = !!initialContent && !!onCancel;
  const [isEmpty, setIsEmpty] = useState(!initialContent);
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notify parent whenever uploadIds changes
  useEffect(() => {
    onUploadIdsChange(uploadIds);
  }, [uploadIds, onUploadIdsChange]);

  const handleUploadSuccess = useCallback((id: string) => {
    setUploadIds((prev) => [...prev, id]);
    setPendingUploads((n) => n - 1);
    setUploadError(null);
  }, []);

  const handleUploadError = useCallback((_err: Error) => {
    setPendingUploads((n) => n - 1);
    setUploadError(
      "Couldn't upload image — it may be too large (max 10 MB) or an unsupported format.",
    );
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        underline: false,
        // Ctrl/Cmd-click opens a link; a plain click just places the caret, so
        // a linked line stays editable.
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
      }),
      TextStyle,
      Color,
      Underline,
      Image,
      ImageUploadExtension.configure({
        projectId,
        orgEmployeeId,
        apiBaseUrl,
        onUploadStart: () => {
          setPendingUploads((n) => n + 1);
        },
        onUploadSuccess: handleUploadSuccess,
        onUploadError: handleUploadError,
      }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: buildMentionSuggestion(boardId, apiBaseUrl),
      }),
    ],
    content: initialContent || '',
    onUpdate: ({ editor: e }) => {
      setIsEmpty(e.isEmpty);
    },
    editorProps: {
      attributes: {
        class:
          'min-h-[60px] px-3 py-2 text-sm text-slate-700 focus:outline-none prose prose-sm max-w-none',
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          handleSubmit();
          return true;
        }
        return false;
      },
    },
  });

  // Auto-focus on mount
  useEffect(() => {
    if (editor) {
      editor.commands.focus();
    }
  }, [editor]);

  const handleFilesSelected = (files: FileList | null) => {
    if (!files || !editor) return;
    const valid: File[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
        setUploadError("Couldn't upload image — unsupported format.");
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError("Couldn't upload image — it's larger than 10 MB.");
        continue;
      }
      valid.push(file);
    }
    if (valid.length > 0) {
      setUploadError(null);
      editor.commands.uploadImages(valid);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = () => {
    if (!editor || editor.isEmpty || pendingUploads > 0) return;
    onSubmit(JSON.parse(JSON.stringify(editor.getJSON())));
    if (!isEditMode) {
      editor.commands.clearContent();
      setIsEmpty(true);
      setUploadIds([]);
    }
  };

  const handleLink = () => {
    if (!editor) return;
    setLinkError(null);
    const previous = (editor.getAttributes('link').href as string | undefined) ?? '';
    const input = window.prompt('Link URL (leave empty to remove)', previous || 'https://');
    if (input === null) return;
    const url = input.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url || url === 'https://') {
      chain.unsetLink().run();
      return;
    }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (!ALLOWED_LINK.test(href)) {
      setLinkError('Links must start with http://, https://, mailto: or tel:.');
      return;
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .unsetMark('link')
        .insertContent(' ')
        .run();
    } else {
      chain.setLink({ href }).run();
    }
  };

  const isPostDisabled = isEmpty || pendingUploads > 0;

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-50 border-b border-slate-200">
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          className={`px-2 py-1 text-xs font-bold rounded transition-colors ${
            editor?.isActive('bold')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Bold"
        >
          B
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          className={`px-2 py-1 text-xs italic rounded transition-colors ${
            editor?.isActive('italic')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Italic"
        >
          I
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          className={`px-2 py-1 text-xs underline rounded transition-colors ${
            editor?.isActive('underline')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Underline"
        >
          U
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            editor?.isActive('bulletList')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Bullet list"
        >
          {'\u2022'}
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            editor?.isActive('orderedList')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Ordered list"
        >
          1.
        </button>
        <button
          type="button"
          onClick={handleLink}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            editor?.isActive('link')
              ? 'bg-slate-200 text-slate-800'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
          aria-label="Link"
          title="Add link (select text first)"
        >
          {'🔗'}
        </button>
        <input
          type="color"
          onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()}
          className="w-6 h-6 border-0 cursor-pointer"
          aria-label="Text color"
          title="Text color"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-2 py-1 text-xs rounded transition-colors text-slate-500 hover:bg-slate-100"
          aria-label="Upload image"
          title="Upload image"
        >
          {'📷'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => handleFilesSelected(e.target.files)}
        />
      </div>

      {/* Editor */}
      <style>{`.comment-editor a { color: #2563eb; text-decoration: underline; overflow-wrap: anywhere; }`}</style>
      <div className="comment-editor">
        <EditorContent editor={editor} />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 px-3 py-2">
        {uploadError && (
          <span className="text-xs text-red-500 self-center" role="alert">
            {uploadError}
          </span>
        )}
        {linkError && (
          <span className="text-xs text-red-500 self-center" role="alert">
            {linkError}
          </span>
        )}
        {pendingUploads > 0 && (
          <span className="text-xs text-slate-400 self-center">
            Uploading {pendingUploads} image{pendingUploads > 1 ? 's' : ''}…
          </span>
        )}
        {isEditMode && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            aria-label="Cancel"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPostDisabled}
          className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-500 rounded-md hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={isEditMode ? 'Save' : 'Post'}
        >
          {isEditMode ? 'Save' : 'Post'}
        </button>
      </div>
    </div>
  );
}
