import {
  Cpu,
  FileIcon,
  FileText,
  FolderClosedIcon,
  ImageIcon,
  LinkIcon,
  Quote,
  TextSelect,
} from 'lucide-react'

import { Mentionable } from '../../../../types/mentionable'

export const getMentionableIcon = (mentionable: Mentionable) => {
  switch (mentionable.type) {
    case 'file':
      return FileIcon
    case 'folder':
      return FolderClosedIcon
    case 'block':
      return TextSelect
    case 'assistant-quote':
      return Quote
    case 'url':
      return LinkIcon
    case 'image':
      return ImageIcon
    case 'pdf':
      return FileText
    case 'model':
      return Cpu
    default:
      return null
  }
}
