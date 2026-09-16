import type { ReactNode, TableHTMLAttributes } from 'react';

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Visible or visually hidden caption. Every data table must have one. */
  caption: string;
  hideCaption?: boolean;
  children: ReactNode;
}

export function Table({ caption, hideCaption = false, children, style, ...rest }: TableProps) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table {...rest} style={{ borderCollapse: 'collapse', width: '100%', ...style }}>
        <caption
          className={hideCaption ? 'pc-visually-hidden' : undefined}
          style={
            hideCaption
              ? undefined
              : {
                  textAlign: 'start',
                  captionSide: 'top',
                  font: '600 14px/1.4 var(--pc-font-sans)',
                  padding: 'var(--pc-space-2) 0',
                }
          }
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}
