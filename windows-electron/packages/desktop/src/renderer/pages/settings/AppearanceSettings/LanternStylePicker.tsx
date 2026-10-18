/**
 * Settings → Appearance: pick the Lantern style (Classic or HUD). Light/dark
 * stays in the theme gallery below; each style has both.
 */

import { Radio } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  LANTERN_STYLES,
  setLanternStyle,
  useLanternStyle,
  type LanternStyle,
} from '@/renderer/utils/theme/lanternStyle';
import styles from './LanternStylePicker.module.css';

const LanternStylePicker: React.FC = () => {
  const { t } = useTranslation();
  const active = useLanternStyle();
  return (
    <Radio.Group
      className={styles.group}
      value={active}
      onChange={(value: LanternStyle) => void setLanternStyle(value)}
      data-testid='lantern-style-picker'
    >
      {LANTERN_STYLES.map((style) => (
        <Radio key={style} value={style} className={styles.radio}>
          {({ checked }: { checked: boolean }) => (
            <div className={classNames(styles.card, checked && styles.checked)} data-testid={`lantern-style-${style}`}>
              <div className={classNames(styles.preview, styles[style])}>
                <span className={styles.side} />
                <span className={styles.plate} />
                <span className={classNames(styles.plate, styles.plateTwo)} />
                {style === 'hud' && <span className={styles.sun} />}
              </div>
              <div className={styles.name}>{t(`settings.lanternStyle.${style}`)}</div>
              <div className={styles.desc}>{t(`settings.lanternStyle.${style}Desc`)}</div>
            </div>
          )}
        </Radio>
      ))}
    </Radio.Group>
  );
};

export default LanternStylePicker;
