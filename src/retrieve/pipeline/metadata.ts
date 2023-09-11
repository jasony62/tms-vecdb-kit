import jsonpointer from 'jsonpointer'
import { PointerFilter, RetrievePipeline } from '../pipeline.js'
import { HNSWLib2 } from '../../vectorstores/hnswlib.js'
import { Document } from 'langchain/document'
import fs from 'fs'

import Debug from 'debug'
import { Collection } from 'mongodb'

const debug = Debug('tms-llm-kit:retrieve:pipeline:metadata')

interface MetadataRetrieveOptions {
  filter?: PointerFilter
  matchBy?: string[]
  fromNonvecStore?: boolean
}
/**
 * 根据元数据检索文档
 */
export class MetadataRetrieve extends RetrievePipeline {
  filter: PointerFilter | undefined

  matchBy: string[] | undefined

  matchByPointers: jsonpointer[] | undefined

  fromNonvecStore = false

  loaderArgs: Record<string, any> | undefined

  constructor(vectorStore: HNSWLib2, options?: MetadataRetrieveOptions) {
    if (!vectorStore) throw new Error('没有指定向量数据库实例')

    super(vectorStore)
    if (options?.filter) {
      const { filter } = options
      this.filter = typeof filter === 'string' ? JSON.parse(filter) : filter
    }
    if (options?.matchBy) {
      this.matchBy = options.matchBy
      this.matchByPointers = options.matchBy.map((p) => {
        return jsonpointer.compile(p.indexOf('/') !== 0 ? '/' + p : p)
      })
    }
    if (options?.fromNonvecStore === true) {
      this.fromNonvecStore = true
    }
    // 向量数据库的存储路径
    const { directory } = vectorStore
    // 检查是否存在loader.json
    const loderfilepath = `${directory}/loader.json`
    if (fs.existsSync(loderfilepath)) {
      this.loaderArgs = JSON.parse(
        fs.readFileSync(loderfilepath).toString('utf-8')
      )
    }
  }
  /**
   * 执行一次查询
   * @param cl
   * @param filter
   * @returns
   */
  private async _fetchMongoOnce(
    cl: Collection,
    filter: Record<string, any>
  ): Promise<Document[]> {
    const cursor = cl.find(filter)
    const lcDocs = []
    for await (const rawDoc of cursor) {
      lcDocs.push(
        new Document({
          pageContent: '',
          metadata: rawDoc,
        })
      )
    }
    return lcDocs
  }
  /**
   * 从mongodb获取文档
   *
   * @param documents
   * @returns
   */
  private async _fetchMongo(documents?: Document[]) {
    let mongoArgs = this.loaderArgs
    if (!mongoArgs || typeof mongoArgs !== 'object')
      throw new Error('没有提供mongodb参数')

    const { MongoClient, ObjectId } = await import('mongodb')
    const client = new MongoClient(mongoArgs.connUri)
    const db = client.db(mongoArgs.dbName)
    const cl = db.collection(mongoArgs.clName)

    let result: any
    debug('获取loader信息：\n%O', mongoArgs)
    if (Array.isArray(documents)) {
      for (let doc of documents) {
        let matcher: Record<string, any> = {}
        this.matchBy?.forEach((k) => {
          if (k === '_id') matcher[k] = new ObjectId(doc.metadata[k])
          else matcher[k] = doc.metadata[k]
        })
        debug('mongodb文档筛选条件\n%O', matcher)
        let docs = await this._fetchMongoOnce(cl, matcher)
        if (docs) {
          result ? result.push(...docs) : (result = docs)
        }
      }
    } else if (this.filter) {
      let matcher: Record<string, any> = {}

      result = await this._fetchMongoOnce(cl, matcher)
    }

    client.close()

    return result
  }
  /**
   * 从本地获取文档数据
   *
   * @param documents
   */
  private async _fetchLocal(documents?: Document[]) {
    let result
    if (Array.isArray(documents)) {
      for (let doc of documents) {
        let matcher: PointerFilter = {}
        this.matchByPointers?.forEach((p, index) => {
          if (this.matchBy) matcher[this.matchBy[index]] = p.get(doc.metadata)
        })
        if (this.filter) {
          matcher = {
            ...matcher,
            ...this.filter,
          }
        }
        let docs = await this.vectorStore?.metadataSearch(matcher, {
          fromNonvecStore: this.fromNonvecStore,
        })
        if (docs) {
          if (result) {
            result.push(...docs)
          } else {
            result = docs
          }
        }
      }
    } else if (this.filter) {
      result = await this.vectorStore?.metadataSearch(this.filter, {
        fromNonvecStore: this.fromNonvecStore,
      })
    }
  }
  /**
   * lorder名称
   * @returns
   */
  private get loaderName(): string | undefined {
    return this.loaderArgs?.loaderName
  }
  /**
   * 执行检索操作
   * @param documents 作为检索条件的文档
   * @returns
   */
  async run(documents?: Document[]): Promise<Document[]> {
    let result
    switch (this.loaderName) {
      case 'MongodbCollectionLoader':
        result = await this._fetchMongo(documents)
        break
      default:
        result = await this._fetchLocal(documents)
    }

    if (this.next) {
      return await this.next.run(result)
    }
    return result ?? []
  }
}
