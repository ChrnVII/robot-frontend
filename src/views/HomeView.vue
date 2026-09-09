<script setup>

import { getPlatformInfo } from '@/api/system';
import { ref } from 'vue';

const data = ref(null)


async function fetchData(){
  try {
    const resp = await getPlatformInfo()
    data.value = resp.data
  } catch (error) {
    console.error('请求失败：', error)
  }
}


</script>

<template>
  <div>{{ data }}</div>
  <el-button type="primary" @click="fetchData">获取数据</el-button>
</template>


