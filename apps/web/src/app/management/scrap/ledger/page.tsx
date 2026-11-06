import { ScrapLedgerDashboard } from '@/features/management/scrap-ledger-dashboard';

export default function Page() {
  return <main>
    <p className="seller-kicker">GESTÃO · CONTA-CORRENTE OFICIAL</p>
    <h1>Saldo e histórico de sucata</h1>
    <p>Consulte o saldo por cliente e todos os movimentos publicados nas abas oficiais do Google Planilhas.</p>
    <ScrapLedgerDashboard />
  </main>;
}
