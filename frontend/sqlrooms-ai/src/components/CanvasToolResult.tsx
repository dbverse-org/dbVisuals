import type {ToolRendererProps} from '@sqlrooms/ai-core';
import type {FC} from 'react';

type CanvasToolOutput = {
  success: boolean;
  slot?: string;
  title?: string;
  renderer?: string;
  details?: string;
  warning?: string;
};

const CanvasToolResult: FC<ToolRendererProps<CanvasToolOutput>> = ({
  output,
}) => {
  if (!output) return null;
  if (!output.success) {
    return (
      <div className="bg-muted rounded-md border p-2 text-sm">
        <div className="font-medium">Canvas not updated</div>
        {output.details ? (
          <div className="text-muted-foreground text-xs">{output.details}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="bg-muted rounded-md border p-2 text-sm">
      <div className="font-medium">
        Updated {output.slot}: {output.title}
      </div>
      <div className="text-muted-foreground text-xs">
        {output.renderer}
        {output.details ? ` - ${output.details}` : ''}
      </div>
      {output.warning ? (
        <div className="mt-1 text-xs text-amber-700">{output.warning}</div>
      ) : null}
    </div>
  );
};

export default CanvasToolResult;
