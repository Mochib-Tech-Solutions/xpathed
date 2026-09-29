import Icon from "../../components/Icon";

export default function ChatPanel() {
  return (
    <aside
      className="flex h-[38%] min-h-[180px] flex-col border-t border-line sm:h-auto sm:min-h-0 sm:border-t-0 sm:border-r"
      aria-label="Chat"
    >
      <div className="flex min-h-11 items-center px-3 py-1.5 sm:min-h-[53px] sm:py-2.5 md:px-4">
        <h1 className="text-base font-[550]">Chat</h1>
      </div>
      <div className="min-h-0 flex-1" />
      <div
        className="mx-3 my-2 flex items-end rounded-[9px] border border-[#dedbe3] bg-white p-1.5 sm:my-3 sm:p-2.5"
        title="Command resolution is not available yet."
      >
        <textarea
          className="h-7 w-full min-w-0 resize-none border-0 bg-transparent p-[3px] leading-normal placeholder:text-muted placeholder:opacity-100 sm:h-auto"
          aria-label="Describe an element"
          placeholder="Describe an element…"
          rows={2}
          disabled
        />
        <button
          type="button"
          className="flex size-[29px] shrink-0 items-center justify-center rounded-[5px] border-0 bg-accent text-white"
          aria-label="Send command"
          disabled
        >
          <Icon name="arrow" size={17} />
        </button>
      </div>
    </aside>
  );
}
