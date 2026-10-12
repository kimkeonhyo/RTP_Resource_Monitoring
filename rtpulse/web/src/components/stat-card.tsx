export default function StatCard({
  label,
  value,
  color = "cyan",
}: {
  label: string;
  value: string | number;
  color?: "cyan" | "green" | "yellow" | "red";
}) {
  const colorMap = {
    cyan: "text-cyan-400",
    green: "text-green-400",
    yellow: "text-yellow-400",
    red: "text-red-400",
  };
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-xs text-faint mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorMap[color]}`}>{value}</p>
    </div>
  );
}
