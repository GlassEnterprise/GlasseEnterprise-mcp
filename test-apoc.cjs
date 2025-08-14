const neo4j = require('neo4j-driver');

async function testAPOC() {
  const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', 'Hello@neo4j')
  );

  try {
    const session = driver.session();
    
    console.log('Testing APOC installation...\n');
    
    // Test 1: Check if APOC procedures are available
    const result = await session.run(`
      CALL dbms.procedures() 
      YIELD name 
      WHERE name STARTS WITH 'apoc' 
      RETURN count(*) AS apocCount
    `);
    
    const apocCount = result.records[0].get('apocCount').toNumber();
    console.log(`✅ APOC procedures found: ${apocCount}`);
    
    if (apocCount > 0) {
      // Test 2: Try a simple APOC function
      const testResult = await session.run(`
        RETURN apoc.version() AS version
      `);
      console.log(`✅ APOC version: ${testResult.records[0].get('version')}`);
      
      // Test 3: Test apoc.merge.node (the one your MCP server needs)
      await session.run(`
        CALL apoc.merge.node(['TestNode'], {id: 'test123'}, {name: 'Test'}) YIELD node
        RETURN node
      `);
      console.log('✅ apoc.merge.node works!');
      
      // Clean up test node
      await session.run(`
        MATCH (n:TestNode {id: 'test123'})
        DELETE n
      `);
      
      console.log('\n🎉 APOC is fully installed and working!');
      console.log('Your MCP server should now work correctly.');
    } else {
      console.log('❌ APOC is not installed');
    }
    
    await session.close();
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await driver.close();
  }
}

testAPOC();
