// Character Studio on its own full page (Characters → Studio → full screen).
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Page } from '@/components/shell/page'
import { IconButton } from '@/components/ui/button'
import { CharacterStudio } from './Studio'

export function StudioPage(): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <Page scroll={false} className="flex flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-[color-mix(in_oklab,var(--panel-solid)_75%,transparent)] px-4 backdrop-blur-xl max-md:gap-1.5 max-md:px-2">
        <IconButton label="Back" className="max-md:size-10" onClick={() => navigate('/characters')}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">Character Studio</div>
          <div className="truncate text-[11.5px] text-fg-3 max-md:hidden">Ideas, references, models and LoRAs → finished characters</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-5 pt-4 pb-5 max-md:overflow-y-auto max-md:px-3 max-md:pt-3">
        <CharacterStudio fill />
      </div>
    </Page>
  )
}
