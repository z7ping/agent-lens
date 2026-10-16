import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from './ui'

/** 所有会话图片共用固定缩略图与弹窗，不向页面开放任意尺寸参数。 */
export function ImagePreview({ src, alt }: { src: string; alt?: string | undefined }) {
  const { t } = useTranslation('common')
  const [openSource, setOpenSource] = useState<string | null>(null)
  const name = alt || t('imagePreview.image')
  return <>
    <Button variant="media" aria-label={t('imagePreview.open', { name })}
      title={t('imagePreview.open', { name })} onClick={() => setOpenSource(src)}>
      <img src={src} alt={name} loading="lazy" decoding="async"/>
    </Button>
    <Dialog open={openSource === src} size="xlarge" title={name} onClose={() => setOpenSource(null)}>
      <img className="image-preview-expanded" src={src} alt={name}/>
    </Dialog>
  </>
}
