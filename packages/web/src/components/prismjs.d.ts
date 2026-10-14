declare module 'prismjs' {
  export interface Token {
    type: string
    content: string | Token | Array<string | Token>
    alias?: string | string[]
  }
  export type Grammar = Record<string, unknown>
  const Prism: {
    languages: Record<string, Grammar | undefined>
    tokenize(code: string, grammar: Grammar): Array<string | Token>
  }
  export default Prism
}
declare module 'prismjs/components/*'
