import {
  Calendar,
  User,
  FileText,
  StickyNote,
  Lightbulb,
  MessageCircle,
  Book,
  Box,
  ListTree,
  LucideIcon,
  Quote,
  Building2,
  Tag,
  Network,
  Search,
  Settings,
  Home,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronRightSmall,
  Save,
  Loader2,
  CircleCheck,
  CircleAlert,
  Link2,
  Compass,
  ArrowDownLeft,
  ArrowUpRight,
  MessageSquare,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  Command as CommandIcon,
  Hash,
  BookOpen,
  Image as ImageIcon,
  Video,
  Music,
  File as FileIcon,
  FileType,
} from "lucide-react";

/**
 * Map a memex-fs node type to a lucide icon. Types come from user
 * intent (the id prefix drives them), so we recognise the common
 * ones and fall back to a neutral box.
 *
 * Keep this map additive — when a new type appears in the wild, add
 * it here; do NOT alias rare types to unrelated icons.
 */
export function typeIcon(typeName: string | undefined): LucideIcon {
  switch ((typeName ?? "").toLowerCase()) {
    case "daily":
      return Calendar;
    case "person":
    case "people":
      return User;
    case "paper":
    case "papers":
      return FileText;
    case "note":
    case "notes":
      return StickyNote;
    case "concept":
    case "concepts":
      return Lightbulb;
    case "post":
    case "posts":
      return MessageCircle;
    case "source":
    case "sources":
      return Book;
    case "claim":
    case "claims":
      return Quote;
    case "org":
    case "organization":
      return Building2;
    case "tag":
      return Tag;
    case "topic":
      return Hash;
    case "img":
    case "image":
      return ImageIcon;
    case "video":
      return Video;
    case "audio":
      return Music;
    case "pdf":
      return FileType;
    case "file":
      return FileIcon;
    default:
      return Box;
  }
}

export {
  Calendar,
  User,
  FileText,
  StickyNote,
  Lightbulb,
  MessageCircle,
  Book,
  Box,
  ListTree,
  Network,
  Search,
  Settings,
  Home,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronRightSmall,
  Save,
  Loader2,
  CircleCheck,
  CircleAlert,
  Link2,
  Compass,
  ArrowDownLeft,
  ArrowUpRight,
  MessageSquare,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  CommandIcon,
  Hash,
  BookOpen,
  ImageIcon,
  Video,
  Music,
  FileIcon,
  FileType,
};
