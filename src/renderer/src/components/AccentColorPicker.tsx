import { useRef, useState, type CSSProperties } from 'react'
import { HexColorPicker } from 'react-colorful'
import { Check, Palette } from 'lucide-react'
import { ACCENT_PRESETS, colorContrast, normalizeAccentColor } from '../../../shared/appearance'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { ErrorPanel, Spinner } from './primitives'
import { errorMessage } from '../lib'
import '../accent-color-picker.css'

export function AccentColorPicker({
  color,
  onChange,
  disabled = false
}: {
  color: string
  onChange: (color: string) => Promise<void>
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(color)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const unavailable = disabled || busy
  const selected = normalizeAccentColor(color)
  const custom = !ACCENT_PRESETS.some((preset) => preset.color === selected)
  const swatchText =
    colorContrast(selected, '#11161C') > colorContrast(selected, '#FFFFFF') ? '#11161C' : '#FFFFFF'
  async function save(value: string) {
    if (running.current || disabled) return
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
      setError('请输入完整的六位十六进制颜色，例如 #F36AA9。')
      return
    }
    if (normalizeAccentColor(value) === selected) {
      setError('')
      setOpen(false)
      return
    }
    running.current = true
    setBusy(true)
    setError('')
    try {
      await onChange(normalizeAccentColor(value))
      setOpen(false)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <div className="accent-color-control">
      <div className="accent-presets" role="group" aria-label="主题色">
        {ACCENT_PRESETS.map((preset) => (
          <Button
            unstyled
            key={preset.color}
            type="button"
            className="accent-color-option"
            aria-label={`主题色：${preset.label}`}
            aria-pressed={selected === preset.color}
            disabled={unavailable}
            style={{ '--swatch-color': preset.color } as CSSProperties}
            onClick={() => void save(preset.color)}
          >
            <span className="accent-swatch">
              {selected === preset.color && <Check size={13} aria-hidden="true" />}
            </span>
            <span>{preset.label}</span>
          </Button>
        ))}
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (running.current) return
            if (next) {
              setDraft(selected)
              setError('')
            }
            setOpen(next)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              unstyled
              type="button"
              className="accent-color-option"
              aria-label="自定义主题色"
              aria-pressed={custom}
              disabled={unavailable}
            >
              <span
                className="accent-swatch custom-swatch"
                style={custom ? { background: selected, color: swatchText } : undefined}
              >
                <Palette size={15} aria-hidden="true" />
              </span>
              <span>自定义</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="accent-picker-popover" align="start" aria-label="自定义主题色">
            <div className="accent-picker-heading">自定义主题色</div>
            <div className="accent-palette" inert={unavailable}>
              <HexColorPicker
                color={/^#[0-9a-f]{6}$/i.test(draft) ? draft : selected}
                onChange={(value) => {
                  if (!unavailable) {
                    setDraft(value)
                    setError('')
                  }
                }}
              />
            </div>
            <Label unstyled className="accent-hex-field">
              <span>颜色值</span>
              <Input
                unstyled
                value={draft}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                aria-label="颜色值"
                disabled={unavailable}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setError('')
                }}
              />
            </Label>
            {error && <ErrorPanel message={error} />}
            <div className="accent-picker-actions">
              <Button
                unstyled
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                unstyled
                type="button"
                className="button primary"
                disabled={unavailable}
                onClick={() => void save(draft)}
              >
                {busy && <Spinner size={13} />}应用颜色
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {!open && error && <ErrorPanel message={error} />}
      <p className="accent-color-description">
        当前颜色 {selected}，会自动适配深浅外观的文字对比度。
      </p>
    </div>
  )
}
