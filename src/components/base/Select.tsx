import clsx from 'clsx'
import styles from './Select.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

/** 原生选择器保留系统键盘、触控和辅助服务的选项行为。 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}) => (
  <select
    className={clsx(styles.trigger, className)}
    aria-label={ariaLabel}
    value={options.some((option) => option.value === value) ? value : ''}
    disabled={disabled}
    onChange={(event) => {
      const option = options.find((item) => item.value === event.target.value)
      if (option) {
        onChange(option.value)
      }
    }}
  >
    {!options.some((option) => option.value === '') ? (
      <option value="" disabled hidden>
        {placeholder ?? ''}
      </option>
    ) : null}
    {options.map((option) => (
      <option key={option.value} value={option.value} lang={option.lang}>
        {option.label}
      </option>
    ))}
  </select>
)
