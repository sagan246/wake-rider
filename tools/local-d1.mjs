import { DatabaseSync } from 'node:sqlite';
export function createLocalD1(filename=':memory:'){
  const db=new DatabaseSync(filename);
  return {
    raw:db,
    prepare(sql){
      let args=[];
      return {bind(...values){args=values;return this;},async first(){return db.prepare(sql).get(...args)||null;},async run(){const result=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};}};
    }
  };
}
