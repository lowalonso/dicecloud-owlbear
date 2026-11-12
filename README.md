# DiceCloud Roller para Owlbear Rodeo

Extensão do Owlbear Rodeo que traz sua ficha do DiceCloud v2 (D&D 5e) para dentro da mesa.

- **Topo:** retrato, nível e classes, CA, iniciativa (toque para rolar), deslocamento e proficiência.
- **Ficha:** vida com botões −10 a +10 (e vida temporária), atributos com teste e resistência,
  perícias, recursos com bolinhas e descansos.
- **Combate:** vida, armas e ataques, ações bônus, reações.
- **Magias:** CD e ataque, espaços de magia como bolinhas em cada círculo, magias com Conjurar.
- **Itens:** inventário por recipiente, armas com Usar.
- **Mais:** efeitos ativos, características, proficiências e anotações.
- **Log:** últimas rolagens de toda a mesa.

Toda rolagem e todo uso (Usar, Conjurar, Mostrar a todos) aparece para a sala inteira
num cartão no topo da tela. **Usar** e **Conjurar** avisam a mesa, gastam o que a ação consome
(espaço de magia do círculo, usos, recursos como pontos de ki) e já rolam o ataque e os danos.

## Contagem de vida, espaços e recursos

- Vida: botões **−10 −5 −1 +1 +5 +10** em cada barra.
- Vida temporária: usa a barra da ficha quando existe; senão, um contador local.
  O dano na vida normal consome primeiro a vida temporária.
- Espaços de magia, dados de vida e recursos: botões **−** e **+**.
- **Descanso curto / longo** restauram o que a ficha marca para cada descanso
  (o longo também restaura vida e espaços de magia; dados de vida ficam por sua conta).
- Sem login, a contagem fica só no seu navegador. Com login (Opções → Entrar no DiceCloud),
  cada alteração também é gravada na ficha do DiceCloud. A gravação usa a mesma conexão do
  site do DiceCloud (não é uma API oficial) e exige permissão de edição na ficha.
- Se a ficha for alterada no DiceCloud, o valor de lá passa a valer (atualização em até 1 minuto).

## Como instalar

A extensão é só um site estático (sem build). Ela precisa estar hospedada em HTTPS.

1. Publique esta pasta em um host estático (Netlify, Vercel, Cloudflare Pages ou GitHub Pages).
2. No Owlbear Rodeo: perfil → **Extensions** → **Add Extension** → cole a URL do
   `manifest.json` (ex.: `https://seu-site.netlify.app/manifest.json`).
3. Ative a extensão na sala. Cada jogador abre o ícone do d20, cola o link da própria
   ficha em **Opções** e clica em **Salvar e carregar**.

**GitHub Pages em repositório de projeto** (`usuario.github.io/repo/`): os caminhos do
`manifest.json` começam com `/`, então troque para `/repo/icon.svg`, `/repo/index.html`
e `/repo/background.html`.

Para testar localmente: `npx serve .` e use `http://localhost:3000/manifest.json`.
Abrir `index.html` fora do Owlbear também funciona (as rolagens só aparecem no histórico local).

## Ficha

- A ficha precisa estar pública no DiceCloud (**Compartilhar → qualquer pessoa com o link pode ver**),
  ou você entra com usuário e senha em **Opções → Ficha privada**.
- Mudou a ficha? Clique em ↻ para recarregar os modificadores.

## Dados 3D (Dice+)

Se a extensão **Dice+** estiver ativa na sala, as rolagens são enviadas para ela
(`1d20+mod`, `2d20kh1+mod`, `2d20kl1+mod`) e os dados 3D rolam na tela de todos.
O resultado aparece no cartão de notificação. Sem o Dice+, a extensão sorteia os dados sozinha.
A extensão Dice oficial do Owlbear não aceita rolagens vindas de outras extensões.

## Rolagem

- **Normal** respeita vantagem/desvantagem já definida na ficha para aquela perícia.
- **Vantagem / Desvantagem** forçam 2d20 ficando com o maior / menor.
- 20 e 1 naturais são destacados.

## Arquivos

- `manifest.json` — manifesto da extensão
- `index.html`, `main.js`, `style.css` — painel
- `background.html`, `background.js` — notificações e histórico para todos na sala
- `toast.html`, `toast.js` — cartão de notificação
- `dicecloud.js` — API do DiceCloud, leitura da ficha e rolagem
- `ddp.js` — gravação das alterações na ficha do DiceCloud
