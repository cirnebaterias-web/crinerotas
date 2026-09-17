import { Brand } from '@/features/auth/brand';

export default function OfflineFallbackPage() {
  return <main className="seller-app seller-offline-fallback"><Brand /><section className="seller-state"><h1>Vamos reconectar?</h1><p>Esta primeira versão precisa de conexão para carregar sua rota. Nenhuma rota de demonstração foi usada no lugar dos seus dados.</p><a href="/route" className="seller-button seller-primary">Tentar carregar minha rota</a></section></main>;
}
