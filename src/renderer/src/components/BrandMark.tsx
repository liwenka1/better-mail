import artwork from '../../../../resources/brand-mark.svg'

export function BrandMark({ size = 42 }: { size?: number }) {
  return <img src={artwork} width={size} height={size} alt="" draggable={false} />
}
