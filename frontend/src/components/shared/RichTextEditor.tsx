import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Bold, Italic, Strikethrough, Underline as UnderlineIcon, Link as LinkIcon,
  List, ListOrdered, Quote, Indent, Outdent, Palette, Highlighter,
} from 'lucide-react';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
  readOnly?: boolean;
  className?: string;
}

const COLORS = [
  '#1a1a1a', '#dc2626', '#ea580c', '#ca8a04', '#16a34a',
  '#2563eb', '#7c3aed', '#db2777', '#6b7280', '#ffffff',
];

const HIGHLIGHTS = [
  'transparent', '#fef08a', '#bbf7d0', '#bfdbfe', '#e9d5ff',
  '#fecaca', '#fed7aa', '#d1d5db',
];

function ToolbarButton({
  active, onClick, children, title,
}: {
  active?: boolean; onClick: () => void; children: React.ReactNode; title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded hover:bg-muted transition-colors',
        active && 'bg-primary/15 text-primary',
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-0.5" />;
}

function ColorPicker({
  colors, currentColor, onSelect, icon: Icon, title,
}: {
  colors: string[]; currentColor?: string; onSelect: (color: string) => void;
  icon: React.ElementType; title: string;
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        title={title}
        className="p-1.5 rounded hover:bg-muted transition-colors flex items-center gap-0.5"
      >
        <Icon className="h-3.5 w-3.5" />
        <span
          className="w-3 h-0.5 rounded-full block"
          style={{ backgroundColor: currentColor || '#1a1a1a' }}
        />
      </button>
      <div className="absolute top-full left-0 mt-1 p-1.5 bg-popover border border-border rounded-md shadow-md hidden group-hover:grid grid-cols-5 gap-1 z-50 min-w-[120px]">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onSelect(color)}
            className={cn(
              'w-5 h-5 rounded border border-border hover:scale-110 transition-transform',
              color === 'transparent' && 'bg-[repeating-conic-gradient(#ddd_0%_25%,transparent_0%_50%)] bg-[length:8px_8px]',
            )}
            style={color !== 'transparent' ? { backgroundColor: color } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const setLink = useCallback(() => {
    const prev = editor.getAttributes('link').href;
    const url = window.prompt('URL', prev || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-border bg-muted/30">
      <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
        <UnderlineIcon className="h-3.5 w-3.5" />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton active={editor.isActive('link')} onClick={setLink} title="Link">
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List">
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered List">
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>

      <ToolbarButton onClick={() => editor.chain().focus().sinkListItem('listItem').run()} title="Indent">
        <Indent className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().liftListItem('listItem').run()} title="Outdent">
        <Outdent className="h-3.5 w-3.5" />
      </ToolbarButton>

      <ToolbarDivider />

      <ColorPicker
        colors={COLORS}
        currentColor={editor.getAttributes('textStyle').color}
        onSelect={(color) => editor.chain().focus().setColor(color).run()}
        icon={Palette}
        title="Text Color"
      />
      <ColorPicker
        colors={HIGHLIGHTS}
        currentColor={editor.getAttributes('highlight').color}
        onSelect={(color) =>
          color === 'transparent'
            ? editor.chain().focus().unsetHighlight().run()
            : editor.chain().focus().toggleHighlight({ color }).run()
        }
        icon={Highlighter}
        title="Highlight"
      />
    </div>
  );
}

export function RichTextEditor({
  value, onChange, placeholder, minHeight = '120px', readOnly = false, className,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, HTMLAttributes: { class: 'text-primary underline' } }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({ placeholder: placeholder || 'Start typing...' }),
    ],
    content: value || '',
    editable: !readOnly,
    onUpdate: ({ editor: e }) => {
      onChange(e.getHTML());
    },
  });

  // Sync external value changes
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || '', false);
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [readOnly, editor]);

  if (!editor) return null;

  return (
    <div className={cn('border border-border rounded-md overflow-hidden bg-background', className)}>
      {!readOnly && <Toolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none px-3 py-2 focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap]:min-h-[var(--min-h)] [&_.tiptap_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-5 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-5 [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-primary/40 [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:italic [&_.tiptap_blockquote]:text-muted-foreground"
        style={{ '--min-h': minHeight } as React.CSSProperties}
      />
    </div>
  );
}

export default RichTextEditor;
