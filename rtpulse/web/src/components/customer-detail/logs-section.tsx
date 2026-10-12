export default function LogsSection({ logs }: { logs: string[] }) {
  const reversed = [...logs].reverse();
  return (
    <div className="bg-panel border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-2 border-b border-line flex justify-between items-center">
        <span className="text-xs text-faint">최근 {logs.length}개 로그</span>
      </div>
      <div className="overflow-y-auto max-h-80 font-mono text-xs text-muted divide-y divide-line/50">
        {reversed.length === 0 ? (
          <p className="px-4 py-6 text-center text-faint">로그 없음</p>
        ) : (
          reversed.map((line, i) => (
            <div key={i} className="px-4 py-1.5 hover:bg-input/30">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
