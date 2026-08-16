import { useEffect } from 'react'
import { SEO_META } from '@/data/constants'

export function usePageMeta(route: string) {
  useEffect(() => {
    const meta = SEO_META[route] ?? SEO_META['/']
    document.title = meta.title
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (!tag) {
      tag = document.createElement('meta')
      tag.name = 'description'
      document.head.appendChild(tag)
    }
    tag.content = meta.description
  }, [route])
}
