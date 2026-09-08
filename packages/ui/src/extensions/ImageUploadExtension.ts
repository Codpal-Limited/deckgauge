import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface UploadScope {
  projectId?: string;
  orgEmployeeId?: string;
}

export interface ImageUploadOptions {
  projectId?: string;
  orgEmployeeId?: string;
  apiBaseUrl: string;
  onUploadStart: () => void;
  onUploadSuccess: (id: string) => void;
  onUploadError: (error: Error) => void;
}

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUpload: {
      uploadImages: (files: File[]) => ReturnType;
    };
  }
}

export async function uploadImageFile(
  file: File,
  scope: UploadScope,
  apiBaseUrl: string,
): Promise<{ id: string; url: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const qs = scope.orgEmployeeId
    ? `orgEmployeeId=${encodeURIComponent(scope.orgEmployeeId)}`
    : `projectId=${encodeURIComponent(scope.projectId ?? '')}`;
  const res = await fetch(`${apiBaseUrl}/api/uploads?${qs}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json() as Promise<{ id: string; url: string }>;
}

function insertAndUploadImage(
  view: EditorView,
  file: File,
  options: ImageUploadOptions,
  insertPos?: number,
): void {
  const { projectId, orgEmployeeId, apiBaseUrl, onUploadStart, onUploadSuccess, onUploadError } = options;

  const blobUrl = URL.createObjectURL(file);
  const imageNode = view.state.schema.nodes['image']?.create({
    src: blobUrl,
    alt: 'uploading...',
  });
  if (!imageNode) return;

  const tr = view.state.tr;
  view.dispatch(typeof insertPos === 'number' ? tr.insert(insertPos, imageNode) : tr.replaceSelectionWith(imageNode));
  onUploadStart();

  uploadImageFile(file, { projectId, orgEmployeeId }, apiBaseUrl)
    .then(({ id, url }) => {
      const { state } = view;
      const tr = state.tr;
      state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
        if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            src: `${apiBaseUrl}${url}`,
            alt: '',
          });
        }
      });
      view.dispatch(tr);
      URL.revokeObjectURL(blobUrl);
      onUploadSuccess(id);
    })
    .catch((err) => {
      const { state } = view;
      const tr = state.tr;
      let from: number | null = null;
      let to: number | null = null;
      state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
        if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
          from = pos;
          to = pos + node.nodeSize;
        }
      });
      if (from !== null && to !== null) {
        view.dispatch(tr.delete(from, to));
      }
      URL.revokeObjectURL(blobUrl);
      onUploadError(err instanceof Error ? err : new Error(String(err)));
    });
}

function imageFilesFrom(list: FileList | undefined | null): File[] {
  return Array.from(list ?? []).filter((f) => ALLOWED_IMAGE_MIME_TYPES.includes(f.type));
}

export const ImageUploadExtension = Extension.create<ImageUploadOptions>({
  name: 'imageUpload',

  addOptions() {
    return {
      projectId: undefined,
      orgEmployeeId: undefined,
      apiBaseUrl: '',
      onUploadStart: () => {},
      onUploadSuccess: () => {},
      onUploadError: () => {},
    };
  },

  addCommands() {
    return {
      uploadImages:
        (files: File[]) =>
        ({ editor }) => {
          const valid = files.filter((f) => ALLOWED_IMAGE_MIME_TYPES.includes(f.type));
          for (const file of valid) {
            insertAndUploadImage(editor.view, file, this.options);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handlePaste(view, event) {
            const files = imageFilesFrom(event.clipboardData?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            for (const file of files) insertAndUploadImage(view, file, options);
            return true;
          },
          handleDrop(view, event) {
            const dragEvent = event as DragEvent;
            const files = imageFilesFrom(dragEvent.dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const coords = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
            for (const file of files) {
              insertAndUploadImage(view, file, options, coords?.pos);
            }
            return true;
          },
        },
      }),
    ];
  },
});
