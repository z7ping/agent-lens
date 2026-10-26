/** Project/source selector facts computed entirely from slim metadata.
 * No Legacy SessionSummary or Canonical observations.
 */
export interface NativeFacetReader {
  query(input?:{projectLimit?:number}):Promise<{
    installedProducts:Array<{productId:string;installationIds:string[]}>
    projects:Array<{
      id:string;name?:string;repositoryIdentity?:string;lastActivityAt?:string
    }>
    projectsTruncated:boolean
  }>
}
